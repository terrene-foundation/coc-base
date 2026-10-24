#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/dispatch-contract.js` — the dispatch-contract guard's
 * pure predicates (`orchestrator-context-economy.md` MUST-5 + MUST-6), shipped WITH the detector
 * per `cc-artifacts.md` Rule 9.
 *
 * Coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — the predicates a wrong edit would
 * silently widen or narrow:
 *
 *   1  what counts as a NAMED dispatch (the MUST-6 gate)
 *   2  what counts as an explicit push-delivery instruction
 *   3  what counts as WRITE INTENT in a brief
 *   4  the READ-ONLY scope arm that WITHDRAWS a write-intent match
 *   5  which declared tool sets can write
 *   6  the UNKNOWN arm — an agent type with no file must fail OPEN, not closed
 *   7  frontmatter parsing: what makes a record usable at all
 *   8  which TOOLS are inspected at all
 *   9  the empty/absent-prompt fail-open arm
 *  10  evidence bounding
 *  11  the on-disk inventory actually resolves this repo's agents
 *  12  severity is capped below `block` (hook-output-discipline.md MUST-2)
 *
 * BIPOLAR BY CONSTRUCTION: every predicate carries BOTH an accept pole and a reject pole. A set
 * that only ever asserts firing passes identically against a detector that fires on everything —
 * and a set that only ever asserts silence passes identically against a detector that is inert.
 * Both are the shapes these cases exist to lock out, and both are live risks here because the
 * whole guard is capped at advisory: an inert advisory is indistinguishable from a clean session.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each predicate's reddening mutation is named
 * in `reds_under`. The four load-bearing ones were RUN against this file before it landed —
 * MEASURED, not predicted — each set below is what the mutation ACTUALLY reddened:
 *   M-a  drop `if (!name) return null` in detectNamedDispatchWithoutDelivery → cases 02, 03
 *   M-b  delete the READ_ONLY_SCOPE_RX withdrawal in impliesWrite          → cases 12, 13
 *   M-c  collapse canWrite's UNKNOWN branch to `false`                     → cases 19, 20
 *   M-d  drop the DELEGATION_TOOLS filter in inspectDispatch               → case  27
 *   M-e  reinstate `JSON.parse(await readStdinBounded())` in the HOOK      → cases 43, 44, 48
 *        (the real inert-hook bug; see the § 13 block for why the 42 library cases missed it)
 * Each mutation exits 1; the restored file exits 0. Case 12 originally did NOT red under M-b — its
 * brief said "writing", which `\bwrite\b` cannot match, so it was vacuous — and it was rewritten
 * rather than left in. That is the value of running the mutation instead of predicting it: a
 * fixture never shown to red is not a regression guard, and a non-reddening case leaves two live
 * hypotheses (vacuous case OR inert mutation).
 *
 * ── CASES 39a–39l + 72a/72b: the 2026-09-14 additions (agent-definition shadowing) ──
 *
 * ESTABLISHED RED, MEASURED — five mutations, each (a) asserted to change the file's bytes, (b)
 * `node --check`-verified to still PARSE, (c) shown to REACH the code by a probe that read the
 * mutated value BEFORE the suite was run, and (d) restored to a sha256-identical file:
 *   M-dup-1  drop `_dupes.add(rec.name)` in readAgentInventory  → 39a 39b 39e 39h 39i 39j
 *   M-dup-2  unmarked map returns `new Set()` instead of null   → 39c
 *   M-dup-3  delete the predicate's `shadowed.has` firing arm   → 39e 39h 39i 39j
 *   M-dup-4  RE-ORPHAN: drop the inspectDispatch wiring only    → 39j
 *   M-dup-5  restore the blanket "reads the brief's PROSE" why  → 72b
 * M-dup-2 and M-dup-4 are the load-bearing pair, and each reds EXACTLY ONE case. M-dup-2 IS the
 * implementation this change replaced — a root-keyed registry in which "never scanned" and "scanned,
 * none found" were the same empty Set — and it passes every other case in this file, so 39c alone
 * separates a usable tri-state from the non-discriminating shape. M-dup-4 is the re-orphaning
 * mutation: the predicate was orphaned for real once, with the comment "zero callers and zero tests
 * today, so nothing will red to remind you". 39j is that reminder.
 *
 * ── CASES 49–81: the 2026-08-23 additions (workdir-existence arm + the override gate) ──
 *
 * ESTABLISHED RED, MEASURED. Every case below was RUN against the UNMODIFIED tree before the
 * implementation existed: cases 49–81 could not even load (`TypeError:
 * L.extractDeclaredWorkdirs is not a function`, exit 1). Each was then pinned by a mutation that
 * was (a) asserted to change the file's bytes, (b) `node --check`-verified to still PARSE — a
 * syntactically invalid mutation tests NOTHING and its "red" is a module-load error wearing a
 * detector failure's clothes — and (c) reverted to a byte-identical restore, re-verified at
 * 81/81 after every single run. The matrix, as OBSERVED (not predicted):
 *
 *   M-l   delete the workdir predicate          → 55 62 63 64 66 67 68 69 70 71 74 75 76 78
 *   M-m   invert the existsSync verdict         → +56 +72
 *   M-w   drop the `cd` anchor                  → +49
 *   M-x   drop the `worktree` anchor            → 50
 *   M-y   drop the punctuation trim             → 50 54
 *   M-j   drop the anchor SCOPE GATE            → 53
 *   M-o   creation-withdrawal unconditional     → (as M-l)
 *   M-o2  DELETE the creation-withdrawal        → 60 61
 *   M-n   a throwing existsSync ⇒ "missing"     → 59
 *   M-p   downgrade the block to halt-and-report→ 63 67 68 69 70 76
 *   M-r   ignore the receipt (hook)             → 73 74 75 77 78
 *   M-v   no escape offered on the lexical tier → 81
 *   M-t   remove the one-shot unlink (shared lib)→ 75 76
 *   M-d   delete the env channel   (shared lib) → 77 78
 *   M-i   drop the reason from the record       → 74
 *
 * TWO NON-REDDENING RESULTS WERE RESOLVED RATHER THAN READ AS VERDICTS
 * (`instrument-discipline.md` MUST-2(b) — a mutation that does not red leaves TWO live
 * hypotheses: vacuous case, or inert mutation):
 *
 *   1. Removing the URL/relative LOOKBEHIND fence alone reddened NOTHING. Cases 51 and 52 were
 *      NOT vacuous: removing the lookbehind AND the anchor scope gate TOGETHER reds 51 52 53.
 *      The two fences are INDEPENDENTLY SUFFICIENT for those inputs — genuine defense in depth —
 *      so no single-fence mutation can red them. Recorded here so a later reader does not delete
 *      one fence on the evidence that "no test covers it".
 *   2. An earlier M-n produced a SYNTAX ERROR; its exit 1 was a parse failure, not a detector
 *      result, and it was re-run correctly (→ case 59) rather than banked. This is why the
 *      matrix runs `node --check` before reading any result.
 *
 * Cases 63–66 dereference the finding with `f?.` DELIBERATELY: an earlier draft used `f.` and a
 * predicate-deleting mutation CRASHED the runner here, masking which other cases it reddened.
 *
 * ── CASES 82–126: wip-discipline MUST-9 (lane-orchestrator brief without partition) ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12 by a driver that, per mutation, asserted a single anchor,
 * `node --check`-verified the mutant, ran a REACH probe against BOTH the original and the mutant (a
 * differing output is the proof the mutated line executes), ran this runner, then restored the
 * original bytes — `cmp`-verified against a pre-run copy, and 134/134 re-verified after. Observed:
 *
 *   M-9l   lane gate always true                 → 88 100 101
 *   M-9b   drop the STEP-0 branch half           → 101
 *   M-9q   classify ROLE over the unstripped brief → 90 91 92 93 116
 *   M-9v   drop the leaf-denial veto             → 86 87 94 102 103 104 105 106 107
 *   M-9o   grant gate always true                → 68 89
 *   M-9c   drop the compliance gate              → 85 91 126
 *   M-9e/f/g drop ONE element test               → 14 / 17 / 16 cases, each including 82 83 84 99 120
 *   M-9w   unwire from inspectDispatch           → 117 118 120 121 123 124
 *   M-9s   raise severity to halt-and-report     → 15 cases, including 116 122 123
 *   M-9h   drop the hygiene lookahead            → 113 114
 *   M-9d1..d6 drop ONE leaf-denial arm           → exactly 102 / 103 / 104 / 105 / 106 / 107
 *   M-9a1..a5 drop ONE grant arm                 → 85 108 / 109 113 114 116 / 22 cases / 111 / 112
 *   M-G1   guard builds the gate on advisory-only findings → 123 (the pending receipt is consumed)
 *   M-G2   guard renders at `advisory`           → 121 ("the action proceeded" — false at PreToolUse)
 *
 * No mutation in the set was inert. M-9o also reds case 68, which is NOT a MUST-9 case: under "every
 * lane brief is an orchestrator", 68's `cd ${REPO}` prompt reads as a lane brief whenever REPO is
 * itself a `-wt` sibling. On an unmutated tree 68 carries no grant and stays silent. The detector
 * once carried an empty-prompt gate as well; it was DELETED rather than tested, because the lane
 * gate already classifies "" as `none` and no case could separate the two
 * (`instrument-discipline.md` MUST-5(b)).
 *
 * ── CASES 22i–22x (+ 22b re-briefed): MUST-10's PIN recognised as an INSTRUCTION ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12 against a SCRATCH COPY of the library (the live file was never
 * written; byte-equal to its pre-run snapshot at the end). Per mutation: anchor count asserted 1,
 * `node --check` on the mutant, a REACH probe (the 6c prompts classified by the mutant vs the
 * unmutated library — differing output is the proof the mutation changed behaviour), this runner,
 * then a byte-equal restore. Control 150/150. Observed:
 *
 *   M-10r   revert to the pre-fix literal `-C /abs` token test  → 22i 22j 22k 22l 22r 22t 22w
 *   M-10e   drop the in-unit assertion arm                      → 22b 22i 22t 22u 22w
 *   M-10b   drop the path-bound `-C <p> rev-parse` arm          → 22k
 *   M-10a   a universal pin needs no assertion                  → 22j 22l 22w
 *   M-10n   merge the missing-assertion finding into the generic → 22j 22l
 *   M-10q   drop the every/each/all-git-call quantifier         → 22r
 *   M-10u   drop the absolute requirement                       → 22x
 *   M-10v1  drop the preceding-negation veto                    → 22o
 *   M-10v2  drop the flag-as-negated-subject veto               → 22p
 *   M-10c   `-C` token case-insensitive                         → 22s
 *   M-10w   split units on every newline                        → 22t
 *   M-10g   drop `--git-dir` from the token                     → 22u
 *   M-10t   a bare `-C` token is a universal pin                → 22n 22o 22p 22q 22r 22x
 *   M-10f   drop the FORBID form                                → 22c 22v
 *
 * Two first-pass results were RESOLVED, not banked. M-10w first reddened NOTHING with an identical
 * reach probe — an INERT mutation, because 22t's wraps kept flag, quantifier and assertion on one
 * line; 22t was re-wrapped so each break separates a required element. And M-10r first left 22k
 * and 22t green while the probe showed both FIRING — those cases asserted only the classifier's
 * form, not the detector's silence; both now assert both. Both re-measured after the fix.
 *
 * ── CASES 127–138 (+ 81 and 124 INVERTED): override binding, full block render, runner isolation ──
 *
 * ESTABLISHED RED, MEASURED 2026-09-12. Each mutation was applied to a SCRATCH COPY of the checkout
 * (the live files were never written; byte-equal to a pre-run snapshot at the end), anchor count
 * asserted 1, `node --check` on the mutant, a REACH probe driving the mutant hook and the live hook
 * on the same input (differing output = the mutation executes), this runner run inside that copy,
 * then the copy's file restored byte-equal to the live one. Control 162/162. Observed:
 *
 *   M-B1  resolve (consume) the override on non-block findings   → 123 128 129 130 131
 *         (reach: receipt present → consumed. 131 reds too: the halt-and-report call spent the
 *         receipt, so the blocked call it was written for then had none — the defect itself)
 *   M-B2  re-offer the receipt on the non-block tier              → 81 122 124 130
 *   M-B3  render only the blocking findings in a block            → 134 135
 *         (reach: 3 finding lines → 1, still exit 2)
 *   M-S2  section 15 spawns the hook against the checkout again   → 69 70 73 74 75 138
 *         and the SENTINEL receipt placed in that copy was DELETED — the same run with the
 *         sandbox intact leaves it byte-identical, so the sentinel check discriminates
 *
 * ── CASES 71a + 76a–76f: the 2026-10-10 CALL BINDING at the real hook boundary ──
 *
 * The receipt is bound to ONE dispatch by a digest the block prints. The expected digest is computed
 * HERE from the library's DOCUMENTED serialization (`documentedDigest`), never by calling the
 * library's own `callDigestOf` — an oracle derived from the subject agrees with it by construction
 * (`evidence-first-claims.md` MUST-5), and this one would not catch a hook that digests the wrong
 * inputs. 71a reads the digest the block actually PRINTS and holds it to that oracle; 76a–76d are the
 * bipolar binding pair (A's receipt does not lift B, is not consumed by B, B names the refusal, and
 * the same receipt then lifts A); 76e reads the use ledger the honours wrote; 76f is the TTL pole.
 * Every sandbox is a `git init`ed repository, because an honoured receipt's use is recorded under
 * the sandbox's MAIN checkout and an unresolvable one refuses the override.
 *
 * ── CASES 54f1–54f4, 54g, 54h, 54k1–54k15: the 2026-10-16 TOKEN-CONTINUATION fix ──
 * ── CASES 54h5, 54m1–54m5, 54n1–54n6, 54p1–54p3, 54q1–54q2, 54r: the 2026-10-16 v3 PIN-ANCHOR fix ──
 *
 * ESTABLISHED RED, MEASURED 2026-10-16 on a scratch git repository holding a copy of the checkout:
 * per mutation the anchor count was asserted 1, the bytes asserted changed, `node --check` run on
 * the mutant, this runner run, and the library restored from a `cp` backup and `cmp`-verified.
 * Control 237/237. Each reddened set below is what the mutation ACTUALLY reddened:
 *
 *   M-v3-1   build LANE_ROOT_POSITION_RX from a second, narrower anchor list (v2's)  → 54m1–54m5 54n6
 *            (ruling item 1: ONE anchor alternation — R2-HIGH `Work only in`/`rooted at` escapes)
 *   M-v3-2   re-add the `<placeholder>` arm to TOKEN_CONTINUATION_RX                → 54q2
 *            (ruling item 2: the continuation skip covers `$`-expressions ONLY)
 *   M-v3-2b  withdraw no placeholder ARGUMENT beside a real pin                     → 54f4
 *   M-v3-2c  require a separator in a placeholder token (v2's filter)               → 54q1
 *   M-v3-eq  let `=` continue a placeholder token                                   → 54n5
 *            (R2-MEDIUM `Worktree: \`WT=<wt>/lane\`` escape)
 *   M-v3-3   let any anchored absolute path count as the pin                        → 54n1–54n4
 *            (ruling item 3: the root a placeholder abbreviates comes from a pin-class anchor —
 *            R2-MEDIUM incidental `cd /tmp` / `checkout /etc/hosts` escape)
 *   M-v3-3b  treat every lane-root placeholder as shorthand when a pin exists       → 54n6 54p1 54p2
 *   M-v3-4   drop the `..` segment test in isPinShorthand                           → 54p1 54p2
 *            (ruling item 4 — R2-LOW `cd <wt>/../../nope` escape)
 *   M-v3-4i  drop the shorthand exception entirely                                  → 54h 54h5
 *   M-v3-5   nest `+` inside the connector repetition (v2's tail shape)             → 54r
 *            (R2 correctness HIGH: 16 separators cost 27 s; 54r runs in a worker with a 5 s wait,
 *            so the regression reds the case instead of hanging the runner)
 *   M-v3-6   make `(` a one-character connector again (drop the aside)              → 54h5
 *            (a real brief pinned `WORKTREE (created for you, …): /abs`)
 *   M-tc     drop the TOKEN_CONTINUATION_RX skip                                    → 54f1 54f2 54f3
 *   M-ph     drop the lane-root placeholder candidate (pass 3)                      → 54g 54m1–54m5
 *            54n1–54n6 54p1–54p3 54q1
 *
 * Rows measured at v2 (2026-10-16, control 219/219) and NOT re-run at v3, kept as dated history:
 *
 *   (v2 M-tc/M-ph/M-ph2/M-ph3 rows are superseded by the v3 rows above: PLACEHOLDER_ROOT_RX and
 *   PLACEHOLDER_ANCHOR_RX no longer exist.)
 *   M-pd   drop `pushd` from WORKDIR_ANCHOR_RX                  → 54k15
 *   M-w    (re-measured; the anchor line moved) drop `cd`       → 49 54a 54b 54c 54d 54k1 54k2 54k3
 *          54k12 54k13 54k14 55 62–64 66–71 71a 74–76 76a 76c–76f 78 81 131–137 R1-OR-consumer
 *   M-x    (re-measured) drop `worktree` ALONE reds NOTHING — an INERT mutation, not a vacuous case:
 *          `work[- ]?tree` matches the same word. The DOUBLE mutation dropping both reds
 *          50 54h 54k4–54k11, so the `M-x → 50` row above holds only for the double mutation.
 *
 * 54k1–54k14 are the shapes a rewrite of the ANCHORING once let through (each blocks at the prior
 * extractor); this fix changes extraction for one candidate class only, so they stay red-guarded by
 * the existing anchor rows rather than a mutation of their own.
 *
 * ── CASES 54s1–54s5 (+ 54g 54m1–54m5 54n1–54n5 54p3 54q1 MOVED block → advisory): the 2026-10-17
 *    ROOT ruling — a placeholder-ONLY lane root ──
 *
 * With no real absolute pin anywhere in the brief, a lane root that is only an unfilled
 * `<placeholder>` is a TEXT reading, not a filesystem fact, so `hook-output-discipline.md` MUST-2
 * caps it below `block`: `detectMissingWorkdirPath` emits it at `advisory`. The two structural
 * blocks stand — an ABSOLUTE root absent from disk, and a non-shorthand placeholder beside a real
 * `Worktree: /abs` pin. `blocksOn`/`advisesOn` now read `missing` only under their own severity, so
 * every case above names the tier it expects. The MOVED cases each have no real pin; every case
 * with one (54f*, 54h*, 54n6, 54p1, 54p2) and every absolute one (54k*, 54q2) keeps its expectation.
 *
 * ESTABLISHED RED, MEASURED 2026-10-17 via `trestle run --repo <lane worktree>` on the mutated
 * working tree (each mutant `node --check`ed, a reach probe showing the mutant's severity differs
 * from the final library's on the same brief, restored from a `cp` backup and `cmp`-verified):
 *   M-adv-A   restore `block` for the placeholder-only lane root          → 54g 54m1–54m5 54n1–54n5
 *             54p3 54q1 54s1 54s2 54s3                         (226/242)
 *   M-adv-B   downgrade the absolute-missing-root block to advisory       → 54k1–54k15 54s4 54q2 63
 *             67 68 69 70 71 71a 74 75 76 76a 76c 76d 76f 76e R1-OR-consumer 78 81 131–137 (200/242)
 *   M-adv-A2  downgrade every placeholder-only missing set, pin or not   → 54n6 54p1 54p2 54s5 (238/242)
 *
 * ── CASES 54t1–54t10, 72c (+ 54g arm 2, 54n1–54n4, 54s3 RETURNED advisory → block): the 2026-10-17
 *    R1 fix — security R1 refuted the gate above ──
 *
 * The downgrade keyed on "no ABSENT absolute root and no PIN-CLASS pin", so an EXISTING absolute
 * lane root under a non-pin anchor (or a pin anchor with intervening words) — 54t1–54t7 — and an
 * absolute prefix fused to a placeholder, read whole as one token and never disk-checked —
 * 54t8–54t10 — each dropped a placeholder root to advisory. The gate is now `placeholderOnly`
 * from `readDeclaredWorkdirs`' single pass: EVERY lane root a PURE `<placeholder>` (opens with
 * `<`). 72c spawns the real hook on a pure-placeholder brief: exit 0 with a rendered advisory line.
 *
 * ESTABLISHED RED, MEASURED 2026-10-17 via `trestle run --repo <lane worktree>` (control 253/253;
 * mutant `node --check`ed, a reach probe showed the mutant's severity flip block → advisory on a
 * MED and a LOW brief, library restored from a `cp` backup and `cmp`-verified):
 *   M1   revert the gate to the 0036919dc predicate                → 54g 54n1–54n4 54s3 54t1–54t10
 *                                                                      (237/253)
 *
 * ── CASES 54u1–54u8: the 2026-10-17 R2 fix (ruling F1 + F2) ──
 *
 * (F1) a `<…>` whose inside opens with a drive letter or URL scheme wraps a LOCATION, so it is not a
 * pure placeholder (`isPurePlaceholder` / `LOCATION_PLACEHOLDER_RX`) — 54u1–54u3; (F2) a home- or
 * UNC-rooted lane root disqualifies `placeholderOnly` though it is never disk-checked
 * (`namesHomeOrUncLaneRoot`) — 54u4–54u7; 54u8 is the prohibition pole, which stays advisory.
 *
 * ESTABLISHED RED, MEASURED 2026-10-17 via `trestle run --repo <lane worktree>` (control 261/261;
 * each mutant `node --check`ed, a reach probe showed its severity flip on an F1 / F2 brief against
 * the unmutated library, restored from a `cp` backup and `cmp`-verified):
 *   M-F1   drop the LOCATION_PLACEHOLDER_RX test from isPurePlaceholder   → 54u1 54u2 54u3 (258/261)
 *   M-F2   drop the namesHomeOrUncLaneRoot term from placeholderOnly     → 54u4–54u7      (257/261)
 *   M-F2w  drop the prohibition fence from namesHomeOrUncLaneRoot        → 54u8           (260/261)
 *
 * Pure functions against in-memory inputs plus throwaway tmpdirs. No network, no live session. The
 * only sink written is the use ledger, inside a runner-created sandbox. The hook-boundary cases spawn
 * the real hook as a child process, ONLY through `spawnHook`, inside runner-created sandboxes that
 * are removed on exit.
 */

import "../_lib/no-ambient-git.cjs";
import { materializeFixtureText } from "../../hooks/lib/fixture-home.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/dispatch-contract.js"));
const HOOK = path.join(REPO, ".claude/hooks/dispatch-contract-guard.js");
/** The RE-TASK entry (SendMessage), registered apart so its row can declare on_incomplete: continue. */
const RETASK_HOOK = path.join(REPO, ".claude/hooks/dispatch-retask-guard.js");

/**
 * HOOK-SPAWN SANDBOX. Every child-process run of the real hook gets its cwd AND its
 * `CLAUDE_PROJECT_DIR` set to its OWN mkdtemp project directory, never the checkout this runner was
 * started from. Those two are the ONLY roots the hook's override gate searches for a receipt: the
 * invoking tree is the hook's cwd, and the one extra root is `CLAUDE_PROJECT_DIR`
 * (`hooks/dispatch-contract-guard.js` passes `extraRoots: () => [PROJECT_DIR]`; candidates are built
 * by `hooks/lib/override-receipt.js::createOverrideGate` → `receiptCandidateRecords`). Pinning both
 * keeps every receipt a case writes, and every receipt the hook could consume, inside a directory
 * this runner created. Each sandbox is ALSO a git repository of its own, so the use ledger an
 * honoured receipt appends to (`<main checkout>/.claude/learning/override-receipt-uses.jsonl`)
 * resolves INSIDE the sandbox too — never in the checkout this runner was started from.
 *
 * WHY (2026-09-12): the earlier revision drove the hook with `CLAUDE_PROJECT_DIR` = the checkout and
 * opened each receipt section with an unconditional delete of
 * `<checkout>/.claude/dispatch-authz/dispatch-contract-allow` — so running this fixture DELETED an
 * operator's real pending override. MEASURED: a sentinel receipt placed in a scratch copy of the
 * checkout was gone after a 150/150 run. Its comment argued a sandbox "would test a different
 * thing"; it does not, because the hook reads receipts from those two roots and nowhere else.
 *
 * The hook ALSO reads the project's `.claude/agents/` (the MUST-5 inventory), which is the one thing
 * copied in. The hook's CODE is still the checkout's, because that is what is under test.
 */
const TMP_REAL = fs.realpathSync(os.tmpdir());
const REPO_REAL = fs.realpathSync(REPO);
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const sandboxes = [];
function makeHookSandbox(label) {
  // Asserted BEFORE the first write: a temp root inside the checkout would put the sandbox, and
  // every receipt written to it, back inside the tree this exists to protect.
  if (within(TMP_REAL, REPO_REAL)) {
    throw new Error(`REFUSING hook sandbox: temp root ${TMP_REAL} lies inside the checkout ${REPO_REAL}`);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_REAL, `dispatch-contract-${label}-`)));
  const receipt = path.join(dir, L.OVERRIDE_RECEIPT_REL);
  if (dir === TMP_REAL || !within(dir, TMP_REAL) || within(dir, REPO_REAL) ||
      within(REPO_REAL, dir) || !within(receipt, dir)) {
    throw new Error(`REFUSING hook sandbox ${dir}: not a fresh temp dir disjoint from ${REPO_REAL}`);
  }
  fs.cpSync(path.join(REPO, ".claude", "agents"), path.join(dir, ".claude", "agents"), { recursive: true });
  // Its own repository, so the use ledger resolves to THIS sandbox as the main checkout.
  spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const sb = { dir, receipt };
  sandboxes.push(sb);
  return sb;
}

/**
 * The digest a receipt must carry to lift `payload`, from the library's DOCUMENTED serialization
 * (`hooks/lib/override-receipt.js` § THE CALL DIGEST) — computed here, independently of the
 * library's own `callDigestOf`, so a hook that digests the wrong inputs cannot agree with this
 * oracle by construction.
 */
function documentedDigest(payload, findingIds) {
  const ti = routeLegacyLaunch(payload).tool_input || {};
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        "coc-override-receipt/call-digest/v1",
        payload.tool_name,
        typeof ti.subagent_type === "string" ? ti.subagent_type : "",
        typeof ti.prompt === "string" ? ti.prompt : "",
        [...new Set(findingIds)].sort(),
      ]),
      "utf8",
    )
    .digest("hex");
}
/** The one-line JSON receipt, as a blocked caller writes it. */
const receiptLine = (digest, reason, writtenAt) =>
  JSON.stringify({ digest, reason, written_at: writtenAt || new Date().toISOString() });
/** The digest a block PRINTED in its receipt template, or null. */
const printedDigest = (text) => {
  // String `match`, not the RegExp method: case 138's start-site count is lexical, and a RegExp
  // method call spelled with that verb reads to it as a process start.
  const m = String(text || "").match(/"digest":"([0-9a-f]{64})"/);
  return m ? m[1] : null;
};
const BLOCK_RULE = "agents/worktree-orchestration-absolute-path-pin";

/**
 * EFFORT ROUTING (2026-10-12) made every launch carry a `ROLE:` first line and the `effort` its role
 * maps to, and the guard BLOCKS a launch that does not. Every hook-boundary case written before that
 * decision sends a launch with neither, so each would now draw an `agents/effort-routing` block that
 * has nothing to do with the predicate the case exists to pin. This routes such a LEGACY launch to a
 * valid role — the first line `ROLE: routine-implementation` and `effort: "medium"`, the pair the
 * routing table assigns — so the case keeps testing exactly what it tested, under the new contract.
 * No assertion changes. A launch that already carries a ROLE line or an `effort` key is passed
 * UNTOUCHED, which is how the effort cases below send unrouted, mis-routed and overridden launches.
 * `documentedDigest` applies the SAME routing, so a receipt digest names the bytes the hook receives.
 */
const LEGACY_ROLE = "routine-implementation";
const LEGACY_EFFORT = "medium";
function routeLegacyLaunch(payload) {
  if (!payload || typeof payload !== "object" || !["Agent", "Task"].includes(payload.tool_name)) return payload;
  const ti = payload.tool_input;
  if (!ti || typeof ti !== "object" || typeof ti.prompt !== "string") return payload;
  if (/^\s*ROLE:/.test(ti.prompt) || Object.prototype.hasOwnProperty.call(ti, "effort")) return payload;
  return { ...payload, tool_input: { ...ti, prompt: `ROLE: ${LEGACY_ROLE}\n${ti.prompt}`, effort: LEGACY_EFFORT } };
}

/**
 * The ONE call site that starts the hook. Refuses any project dir this runner did not create.
 * `opts.raw` sends the payload exactly as given (no legacy routing); `opts.hook` runs a COPY of the
 * hook tree that lives INSIDE the sandbox (the routing-table cases), and is refused anywhere else.
 */
/** spawnHook's openStdin producer: start the hook, write the payload, never end stdin, report its exit + stdout. */
const OPEN_PRODUCER = [
  "const [hook, body] = process.argv.slice(1);",
  "const c = require('node:child_process').spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'inherit'] });",
  "let out = ''; c.stdout.on('data', (d) => { out += d; });",
  "c.stdin.write(body);",
  "c.on('exit', (code) => { process.stdout.write(JSON.stringify({ code, out })); process.exit(0); });",
].join("\n");
function spawnHook(sb, input, extraEnv = {}, opts = {}) {
  if (!sandboxes.includes(sb)) throw new Error("REFUSING hook spawn: not a runner-created sandbox");
  const hook = opts.hook || HOOK;
  if (hook !== HOOK && hook !== RETASK_HOOK && !within(hook, sb.dir)) throw new Error("REFUSING hook spawn: hook copy outside the sandbox");
  let body = input;
  if (!opts.raw) {
    try {
      const parsed = JSON.parse(input);
      body = JSON.stringify(routeLegacyLaunch(parsed));
    } catch {
      body = input; // not JSON — the unparseable-payload cases send it verbatim
    }
  }
  const env = { ...process.env, ...extraEnv, CLAUDE_PROJECT_DIR: sb.dir };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, L.OVERRIDE_ENV)) delete env[L.OVERRIDE_ENV];
  // openStdin (E90): the same sandbox-pinned hook, started by a producer that writes the payload and NEVER closes
  // stdin — the one way to reach the reader's open-no-EOF timer. Still this ONE call site (case 138).
  const r = spawnSync("node", opts.openStdin ? ["-e", OPEN_PRODUCER, hook, body] : [hook],
    { input: opts.openStdin ? "" : body, encoding: "utf8", env, cwd: sb.dir });
  if (!opts.openStdin) return r;
  let res = null;
  try { res = JSON.parse(r.stdout); } catch {}
  return { status: res ? res.code : null, stdout: res ? res.out : "", stderr: r.stderr };
}
process.on("exit", () => {
  for (const sb of sandboxes) {
    if (within(sb.dir, TMP_REAL) && !within(sb.dir, REPO_REAL)) {
      try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch {}
    }
  }
});

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

/** Small inventory used by the MUST-5 cases; mirrors the real frontmatter shape. */
const INV = new Map([
  ["analyst", ["Read", "Grep", "Glob"]],
  ["tdd-implementer", ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"]],
  ["reviewer", ["Read", "Bash", "Grep", "Glob", "Task"]],
  ["wildcard-agent", ["*"]],
]);

// ── 1. what counts as a NAMED dispatch ──────────────────────────────────────
check("01", "named dispatch without delivery instruction FIRES",
  !!L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "Investigate X and return your findings." }),
  "expected a finding", "M-a: drop the !name gate");
check("02", "UNNAMED dispatch with the same brief is SILENT",
  L.detectNamedDispatchWithoutDelivery({ prompt: "Investigate X and return your findings." }) === null,
  "unnamed auto-returns; contract does not apply", "M-a: drop the !name gate");
check("03", "whitespace-only name is NOT a named dispatch",
  L.detectNamedDispatchWithoutDelivery({ name: "   ", prompt: "Investigate X." }) === null,
  "blank name must not create a mailbox obligation");

// ── 2. what counts as a push-delivery instruction ───────────────────────────
check("04", "explicit SendMessage instruction SILENCES the MUST-6 arm",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "Do X, then SendMessage the orchestrator." }) === null,
  "explicit push named");
check("05", "prose 'message the main agent' also SILENCES",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "When done, message the main agent with results." }) === null,
  "prose variant recognised");
check("06", "'return your findings' alone does NOT count as a push instruction",
  L.hasPushDeliveryInstruction("Return your findings when complete.") === false,
  "pull contract must not read as push", "M-a");
check("07", "'push your findings' DOES count",
  L.hasPushDeliveryInstruction("push your findings to the orchestrator") === true,
  "push phrasing recognised");

// ── 3. what counts as WRITE INTENT ──────────────────────────────────────────
check("08", "'create the fixtures' is write intent",
  L.impliesWrite("Create the fixture files for the new detector.") === true, "verb+object");
check("09", "'implement the hook' is write intent",
  L.impliesWrite("Implement the hook and register it.") === true, "verb+object");
check("10", "pure analysis brief is NOT write intent",
  L.impliesWrite("Summarise how the scheduler resolves ties. Explain the trade-offs.") === false,
  "no production verb+object", "widen WRITE_INTENT_RX");
check("11", "the noun 'the write path' is NOT write intent",
  L.impliesWrite("Explain the write path through the buffer.") === false,
  "noun must not fire", "drop the verb anchor");

// ── 4. the READ-ONLY scope withdrawal ───────────────────────────────────────
// The brief here MUST contain a live WRITE_INTENT_RX match, or the case is vacuous for M-b: it
// would read false whether the withdrawal arm exists or not. An earlier draft used "the rule files
// I am writing" — `\bwrite\b` never matches "writing", so the case passed under the mutation and
// proved nothing. Caught by running M-b, not by reading the code.
check("12", "READ-ONLY marker WITHDRAWS an otherwise-matching write intent",
  L.impliesWrite("READ-ONLY investigation: describe how you would update the rule files.") === false &&
    L.impliesWrite("describe how you would update the rule files.") === true,
  "scope arm wins, and the same brief without the marker DOES match",
  "M-b: delete READ_ONLY_SCOPE_RX withdrawal");
check("13", "'do NOT edit any file' WITHDRAWS it too",
  L.impliesWrite("Investigate and do NOT edit any file. Update me on the rules.") === false,
  "negative-scope phrasing", "M-b");
check("14", "without the marker the same brief DOES imply write",
  L.impliesWrite("Update the rule files.") === true,
  "the withdrawal must be marker-driven, not unconditional", "M-b inverted");

// ── 5. which declared tool sets can write ───────────────────────────────────
check("15", "Read/Grep/Glob CANNOT write", L.canWrite("analyst", INV) === false, "read-only roster");
check("16", "Write/Edit-bearing set CAN write", L.canWrite("tdd-implementer", INV) === true, "write-capable");
check("17", "Bash-but-no-Write CANNOT write", L.canWrite("reviewer", INV) === false,
  "Bash is not a write tool for this predicate");
check("18", "wildcard '*' CAN write", L.canWrite("wildcard-agent", INV) === true, "built-in wildcard");

// ── 6. the UNKNOWN arm must fail OPEN ───────────────────────────────────────
check("19", "unknown agent type resolves UNKNOWN (null), not false",
  L.canWrite("general-purpose", INV) === null,
  "tri-state, never boolean", "M-c: collapse UNKNOWN to false");
check("20", "write brief to an UNKNOWN agent type is SILENT",
  L.detectWriteTaskToReadOnlyAgent({ subagent_type: "general-purpose", prompt: "Create the files." }, INV) === null,
  "fail open on unknown", "M-c");
check("21", "write brief to a READ-ONLY agent FIRES",
  !!L.detectWriteTaskToReadOnlyAgent({ subagent_type: "analyst", prompt: "Create the fixture files." }, INV),
  "the MUST-5 accept pole", "M-c inverted");
check("22", "write brief to a WRITE-CAPABLE agent is SILENT",
  L.detectWriteTaskToReadOnlyAgent({ subagent_type: "tdd-implementer", prompt: "Create the fixture files." }, INV) === null,
  "the MUST-5 reject pole");

// ── 5b. the REMEDY must be cheaper than the workaround ──────────────────────
// ORIGIN, measured: this detector fired correctly three times in one session against the same
// orchestrator and was worked around all three times. The finding was right and its remedy was
// right; what was wrong was the COST. "Re-target a write-capable agent" left the orchestrator to
// go and find which agents can write, while the incorrect remedy — message the already-running
// agent — was one call away. A halt-and-report whose correct remedy costs more than its incorrect
// one selects for the incorrect one. So the finding now CARRIES the answer, derived from the same
// inventory that decided the mismatch.
// ── 5c. MUST-10's FORBID form must not punish PRECISION ─────────────────────
// ORIGIN, measured: the forbid clause was recognised by ONE canonical sentence,
// `never run a git write`. A brief that forbade git writes MORE specifically — naming
// every destructive verb — was STRICTLY STRONGER and matched NOTHING, so MUST-10 fired on
// six consecutive dispatches whose briefs were safer than the one it would have accepted.
// Six findings correct about the FORM and wrong about the RISK is how an advisory teaches
// its reader to skim it.
// The TWO-VERB bound is the load-bearing half and 22h is its guard: widening a WITHDRAWAL
// predicate is where false NEGATIVES enter, because every accepted phrase can silence a
// real finding. One verb is reachable by ordinary scheduling prose; two distinct verbs in
// one negated sentence is not written by accident.
check("22g", "an ENUMERATED prohibition counts as MUST-10's forbid form",
  L.fixtureContainmentOf(
    "CONTAINMENT: this lane needs NO repository fixture. Do not create one. NEVER run " +
    "`git push`, `git reset --hard`, `git clean -f`, `git checkout --`, `git restore`, or " +
    "`git stash`. Read-only git is fine.",
  ).form === "forbid",
  "a brief stronger than the canonical sentence must not read as no containment", "M-10f: drop the enumerated arm");

check("22h", "ONE destructive verb in a scheduling remark is NOT a containment clause",
  L.fixtureContainmentOf("Never run `git push` until CI is green.").form !== "forbid",
  "the false-NEGATIVE bound — one verb must not silence MUST-10");

check("22i", "the CANONICAL sentence still counts (the remedy the finding text prescribes)",
  L.fixtureContainmentOf(
    "this lane needs no repository fixture; never run a git write command",
  ).form === "forbid",
  "narrowing the canonical form would break the remedy the message tells operators to write");

check("22j", "a brief that MANDATES a fixture still fires",
  L.fixtureContainmentOf(
    "Build a real git repository with backdated commits under the scratch root.",
  ).form !== "forbid",
  "the accept arm must not swallow the case MUST-10 exists for");

check("22b", "the finding NAMES write-capable alternatives, so re-targeting is mechanical",
  (() => {
    const e = L.detectWriteTaskToReadOnlyAgent(
      { subagent_type: "analyst", prompt: "Create the fixture files." }, INV).evidence;
    return e.includes("tdd-implementer") && e.includes("wildcard-agent");
  })(),
  "both write-capable members of INV must be named", "M-c2: drop the hint");

check("22c", "the agent that was REFUSED is never offered back as its own alternative",
  !L.detectWriteTaskToReadOnlyAgent(
    { subagent_type: "analyst", prompt: "Create the fixture files." }, INV)
    .evidence.match(/Write-capable here:[^.]*\banalyst\b/),
  "self-suggestion would be a remedy that cannot work");

check("22d", "with NO write-capable agent in the inventory the hint is OMITTED, never guessed",
  !L.detectWriteTaskToReadOnlyAgent(
    { subagent_type: "analyst", prompt: "Create the fixture files." },
    new Map([["analyst", ["Read"]], ["reviewer", ["Read", "Bash"]]]),
  ).evidence.includes("Write-capable here"),
  "naming an agent that cannot write would spend the trust this advisory runs on");

check("22e", "an UNREADABLE inventory degrades to the un-hinted finding rather than throwing",
  (() => {
    const f = L.detectWriteTaskToReadOnlyAgent(
      { subagent_type: "analyst", prompt: "Create the fixture files." }, INV);
    // The hint is additive: the finding's identity and severity are unchanged by it.
    return f.rule_id === "orchestrator-context-economy/MUST-5" && f.severity === "halt-and-report";
  })(),
  "the hint must not alter the verdict it decorates");

// ── 6b. fixture-containment (worktree-isolation/MUST-10) ─────────
// The incident: a lens dispatched to build adversarial git fixtures ran unpinned commands that
// resolved to the ORCHESTRATOR'S checkout — nine commits landed, seven branches were pushed to the
// real remote. Every pole below is bipolar; the reject poles are what stop this becoming a detector
// that fires on any brief mentioning git.
check("22a", "a fixture-building brief with NO pin FIRES",
  !!L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture and plant three adversarial commits." }),
  "the accept pole — the exact shape of the incident brief", "unpinned repo fixture");
check("22b", "the same brief with an ABSOLUTE -C pin on every call + its assertion is SILENT, as a PIN",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture. Pin every call: git -C /tmp/scratch/fx init, and assert its toplevel before the first write." }) === null &&
    L.fixtureContainmentOf("Build a git repository fixture. Pin every call: git -C /tmp/scratch/fx init, and assert its toplevel before the first write.").form === "pin",
  "the reject pole — pinning is the remedy the evidence names. Carried an assertion since 2026-09-12: MUST-10's PIN is both halves (see 22j)", "M-10e");
check("22c", "the same brief carrying the CONTAINMENT CLAUSE is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a git repository fixture. Never run a git write command anywhere." }) === null,
  "a lane told to run no git write needs no pin — either closes the path");
check("22d", "a READ-ONLY git brief is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Read the git log and summarise the last ten commits." }) === null,
  "no build verb, no repository noun — the over-match this bound exists to refuse");
check("22e", "a build brief with no REPOSITORY noun is SILENT",
  L.detectUnpinnedFixtureDispatch({ prompt: "Build a fixture set of ten prose transcripts." }) === null,
  "both halves are required, or every authoring brief trips it");
check("22f", "an absent or empty prompt is SILENT, never a throw",
  L.detectUnpinnedFixtureDispatch({}) === null && L.detectUnpinnedFixtureDispatch({ prompt: "" }) === null,
  "fail open on nothing to read");
check("22g", "the finding carries halt-and-report, NOT block",
  (L.detectUnpinnedFixtureDispatch({ prompt: "Create a scratch repository fixture." }) || {}).severity === "halt-and-report",
  "lexical evidence cannot carry block", "hook-output-discipline MUST-2");
check("22h", "inspectDispatch SURFACES the finding, so the guard consumes it",
  L.inspectDispatch("Task", { prompt: "Build a git repository fixture." }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10"),
  "a predicate no aggregator calls is inert", "wired, not merely written");

// ── 6c. MUST-10's PIN recognised as an INSTRUCTION (2026-09-12) ─────────
// The defect these close, measured: the pin test accepted only a literal `-C /abs`, so it FIRED on
// every brief carrying the canonical containment clause — a PIN instruction for a path the brief
// cannot know yet — and went SILENT on a bare `-C /tmp/x` pinning one call. Each silent pole asserts
// WHICH form silenced it; each firing pole asserts rule id, severity and which half is missing.
const FX_BUILD = "Build a git repository fixture with three commits and a side branch. ";
const CANON_1 = FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute `-C`/`cwd` on every git call.";
const CANON_2 = FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute `-C <scratch path>`/`cwd` on every git call, asserted before the first write.";
const m10 = (p) => {
  const f = L.detectUnpinnedFixtureDispatch({ prompt: p });
  return { f, form: L.fixtureContainmentOf(p).form };
};
const firesAs = (r, form, evidenceNeedle) =>
  !!r.f && r.f.rule_id === "worktree-isolation/MUST-10" && r.f.severity === "halt-and-report" &&
  r.form === form && r.f.evidence.includes(evidenceNeedle);

check("22i", "the canonical clause WITH its assertion is SILENT, as a PIN",
  (() => { const r = m10(CANON_2); return r.f === null && r.form === "pin"; })(),
  "the defect's own brief: placeholder path + every git call + asserted", "M-10r M-10e");
check("22j", "the canonical clause WITHOUT any assertion FIRES, naming the missing STEP-0 half",
  firesAs(m10(CANON_1), "pin-without-assertion", "mandates no STEP-0 assertion"),
  "MUST-10 PIN = absolute -C on every call WITH a STEP-0 assertion; -C at a non-repo dir walks UP", "M-10r M-10a M-10n");
check("22k", "a placeholder pin asserted by a PATH-BOUND `-C <p> rev-parse --show-toplevel` elsewhere is SILENT",
  (() => { const r = m10(FX_BUILD + "Every git call carries an absolute `-C <scratch path>`. STEP 0: `git -C <scratch path> rev-parse --show-toplevel` must equal it."); return r.f === null && r.form === "pin"; })(),
  "the assertion may sit in its own sentence when it is bound to the pinned path", "M-10r M-10b");
check("22l", "a BARE worktree STEP-0 `rev-parse --show-toplevel` does NOT satisfy the assertion half",
  firesAs(m10(FX_BUILD + "Every git call carries an absolute `-C <scratch path>`. STEP 0: [ \"$(git rev-parse --show-toplevel)\" = \"$(pwd -P)\" ]."),
    "pin-without-assertion", "mandates no STEP-0 assertion"),
  "the lane's own cwd assertion says nothing about the fixture target", "M-10r M-10a M-10n");
check("22m", "an unpinned fixture brief FIRES as `none`, naming no git target",
  firesAs(m10(FX_BUILD + "Merge the side branch back and tag the result."), "none", "pins no git target"),
  "the accept pole with identity");
check("22n", "`-C` mentioned only to REJECT it FIRES",
  firesAs(m10(FX_BUILD + "Do not use `-C`; `git -C` never establishes cwd."), "none", "pins no git target"),
  "the presence of -C is not a pin", "M-10t");
check("22o", "a universal absolute pin under a preceding NEGATION FIRES",
  firesAs(m10(FX_BUILD + "Do not put an absolute `-C` on every git call, asserted or not; cd into the mkdtemp dir instead."),
    "none", "pins no git target"),
  "quantifier + absolute + assertion word, all negated", "M-10v1");
check("22p", "MUST-10's own DO NOT (`git -C` never establishes cwd) under a quantifier FIRES",
  firesAs(m10(FX_BUILD + "An absolute `git -C <scratch path>` never establishes cwd for every git call, asserted or not."),
    "none", "pins no git target"),
  "the flag is the SUBJECT of a negated predicate", "M-10v2");
check("22q", "a PARTIAL pin (`use -C for the init`) FIRES",
  firesAs(m10(FX_BUILD + "Use -C for the init."), "none", "pins no git target"),
  "no quantifier, no absolute", "M-10t");
check("22r", "a CONCRETE absolute pin on ONE call, even asserted, FIRES",
  firesAs(m10(FX_BUILD + "Run `git -C /tmp/scratch/fx init`, asserted with `git -C /tmp/scratch/fx rev-parse --show-toplevel`, then make the commits."),
    "none", "pins no git target"),
  "the three commits run unpinned; a path-bound assertion does not make a partial pin universal", "M-10r M-10q");
check("22s", "lowercase `git -c` (config) is NOT a target flag",
  firesAs(m10(FX_BUILD + "Every git call carries an absolute `-c safe.directory=/tmp/fx` override, asserted before the first write."),
    "none", "pins no git target"),
  "-C is case-sensitive; the i-flag tests run only after the token is replaced", "M-10c");
check("22t", "the canonical clause HARD-WRAPPED across lines is still a PIN",
  (() => { const r = m10(FX_BUILD + "CONTAINMENT: any fixture that builds a repo uses its own mkdtemp dir with an absolute\n`-C <scratch path>`/`cwd` on every\ngit call, asserted before the first write."); return r.f === null && r.form === "pin"; })(),
  "a single newline joins a wrapped sentence; each wrap here separates a required element (absolute | flag | quantifier)", "M-10r M-10w");
check("22u", "a universal absolute `--git-dir` pin, asserted, is SILENT, as a PIN",
  m10(FX_BUILD + "Every git call carries `--git-dir=/tmp/scratch/fx/.git`, asserted against its toplevel before the first write.").form === "pin" &&
    m10(FX_BUILD + "Every git call carries `--git-dir=/tmp/scratch/fx/.git`, asserted against its toplevel before the first write.").f === null,
  "the rule's parenthetical alternative", "M-10g");
check("22v", "the FORBID form is SILENT and classified as FORBID",
  (() => { const r = m10(FX_BUILD + "This lane needs no repository fixture; never run a git write command anywhere."); return r.f === null && r.form === "forbid"; })(),
  "MUST-10's second compliant form, with identity", "M-10f");
check("22w", "inspectDispatch surfaces NO MUST-10 finding for the canonical clause WITH its assertion",
  !L.inspectDispatch("Task", { prompt: CANON_2 }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10") &&
    L.inspectDispatch("Task", { prompt: CANON_1 }, INV).some((f) => f.rule_id === "worktree-isolation/MUST-10"),
  "the wiring pole on BOTH sides — the guard reads what the predicate decides", "M-10r");
check("22x", "a universal pin on a RELATIVE `-C` path, asserted, FIRES",
  firesAs(m10(FX_BUILD + "Every git call carries `-C scratch/fx`, asserted before the first write."), "none", "pins no git target"),
  "a relative -C resolves against the ORCHESTRATOR's cwd — the incident's own target", "M-10u");

// ── 7. frontmatter parsing ──────────────────────────────────────────────────
check("23", "name + tools parse into a record",
  JSON.stringify(L.parseAgentFrontmatter("---\nname: x\ntools: Read, Write\n---\nbody")) ===
    JSON.stringify({ name: "x", tools: ["Read", "Write"] }),
  "canonical shape");
check("24", "a file with NO tools: line yields NO record",
  L.parseAgentFrontmatter("---\nname: x\nmodel: opus\n---\nbody") === null,
  "half-record must not read as 'declares no write tools'", "return a partial record");
check("25", "a file with no frontmatter fence yields NO record",
  L.parseAgentFrontmatter("# just a heading\n") === null, "unfenced");
check("26", "inline-array tools: parse too",
  JSON.stringify(L.parseAgentFrontmatter('---\nname: y\ntools: ["Read", "Edit"]\n---')?.tools) ===
    JSON.stringify(["Read", "Edit"]),
  "both YAML styles");

// ── 8. which TOOLS are inspected at all ─────────────────────────────────────
check("27", "a non-delegation tool yields NO findings",
  L.inspectDispatch("Bash", { name: "lane-a", prompt: "do it" }, INV).length === 0,
  "matcher belt-and-suspenders", "M-d: drop the DELEGATION_TOOLS filter");
check("28", "'Task' IS inspected",
  L.inspectDispatch("Task", { name: "lane-a", prompt: "Investigate." }, INV).length === 1, "Task arm", "M-d");
check("29", "'Agent' IS inspected",
  L.inspectDispatch("Agent", { name: "lane-a", prompt: "Investigate." }, INV).length === 1, "Agent arm", "M-d");
check("30", "one dispatch can carry BOTH findings",
  L.inspectDispatch("Agent", { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files." }, INV).length === 2,
  "MUST-5 and MUST-6 are independent");
check("31", "a well-formed dispatch yields ZERO findings",
  L.inspectDispatch("Agent",
    { name: "lane-a", subagent_type: "tdd-implementer", prompt: "Create the fixture files, then SendMessage the orchestrator." },
    INV).length === 0,
  "the all-clear pole — without it an inert detector would pass every other case");

// ── 9. the empty/absent-prompt fail-open arm ────────────────────────────────
check("32", "named dispatch with an EMPTY prompt is SILENT",
  L.detectNamedDispatchWithoutDelivery({ name: "lane-a", prompt: "" }) === null, "nothing to read");
check("33", "malformed tool_input is SILENT, not a throw",
  L.detectNamedDispatchWithoutDelivery(null) === null && L.detectWriteTaskToReadOnlyAgent(undefined, INV) === null,
  "fail open on garbage");
check("34", "description alone is read as the brief",
  L.promptOf({ description: "Create the fixture files." }).includes("Create"), "both prose fields");

// ── 10. evidence bounding ───────────────────────────────────────────────────
check("35", "clip bounds long evidence and marks truncation",
  L.clip("x".repeat(500)).length <= L.EVIDENCE_MAX + 1 && L.clip("x".repeat(500)).endsWith("…"),
  "advisory stays bounded");
check("36", "clip flattens newlines",
  L.clip("a\n\nb") === "a b", "single-line evidence");

// ── 11. the on-disk inventory resolves THIS repo's agents ───────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-contract-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude/agents/nested"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude/agents/a.md"), "---\nname: ro\ntools: Read, Grep\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/nested/b.md"), "---\nname: rw\ntools: Read, Write\n---\n");
    const inv = L.readAgentInventory(tmp);
    check("37", "walker finds agents at depth", inv.size === 2 && L.canWrite("rw", inv) === true,
      `size=${inv.size}`, "break the recursive walk");
    check("38", "a missing agents dir yields an EMPTY inventory, not a throw",
      L.readAgentInventory(path.join(tmp, "nope")).size === 0, "fail open");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const live = L.readAgentInventory(REPO);
  check("39", "the LIVE repo inventory is non-empty and read-only agents are visible",
    live.size > 10 && L.canWrite("analyst", live) === false,
    `live agents=${live.size}`,
    "this is the positive control: it fires against a corpus already known to hold read-only agents");
}

// ── 11b. AGENT-DEFINITION SHADOWING: the tri-state, and the dispatch arm ────
//
// The predicate this section pins was ORPHANED (zero callers, zero cases) from 2026-09-14 until it
// was re-wired into `inspectDispatch`. Two poles per arm, because the failure it guards is
// silence: a shadowing check that never fires is byte-identical to a repo with no duplicates, and
// this repo HAS no duplicates today (MEASURED: 39 agents, 0 shadowed), so the live corpus can
// never distinguish a working predicate from an inert one. Every firing pole below is therefore
// built on a SYNTHETIC corpus with a planted duplicate.
//
// The UNKNOWN pole (case 39c) is the load-bearing one. The previous implementation kept the
// duplicate set in a module-level root-keyed registry and returned `new Set()` for a root it had
// never scanned — so "never looked" and "looked, found none" were the SAME value, and a fail-closed
// consumer had nothing to branch on. That is the non-discriminating instrument `instrument-
// discipline.md` MUST-1 blocks as evidence. A case asserting only the two Set poles would pass
// identically against that broken shape; 39c is what separates them.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-shadow-"));
  try {
    fs.mkdirSync(path.join(tmp, ".claude/agents/nested"), { recursive: true });
    // SAME `name:`, two files, DIFFERENT capability — the shape that defeats a tool-grant read.
    fs.writeFileSync(path.join(tmp, ".claude/agents/ro.md"), "---\nname: twin\ntools: Read, Grep\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/nested/rw.md"), "---\nname: twin\ntools: Read, Write, Bash\n---\n");
    fs.writeFileSync(path.join(tmp, ".claude/agents/solo.md"), "---\nname: lone\ntools: Read\n---\n");
    const dupInv = L.readAgentInventory(tmp);
    const dupes = L.duplicateAgentNames(dupInv);

    check("39a", "SHADOWING firing pole: a name declared by two files is reported",
      dupes instanceof Set && dupes.has("twin"), `dupes=${dupes && [...dupes].join(",")}`,
      "M-dup-1: drop the `if (out.has(rec.name)) _dupes.add(...)` recording");
    check("39b", "SHADOWING clean pole: a singly-declared name in the SAME scanned inventory is NOT reported",
      dupes instanceof Set && !dupes.has("lone") && dupes.size === 1,
      `size=${dupes && dupes.size}`,
      "a recorder that marks every name, which would pass 39a alone");
    check("39c", "UNKNOWN is NOT clean: a map that was never directory-scanned answers null, not an empty Set",
      L.duplicateAgentNames(new Map([["twin", ["Read"]]])) === null &&
        L.duplicateAgentNames(undefined) === null &&
        L.duplicateAgentNames(L.readAgentInventory(path.join(tmp, "nope"))) instanceof Set,
      "hand-built ⇒ null; scanned-but-absent-dir ⇒ empty Set",
      "M-dup-2: return `new Set()` instead of null for an unmarked map — the ORIGINAL registry shape");
    check("39d", "the resolved tool set for a shadowed name is one of the two declared records — the ambiguity is real, not theoretical",
      JSON.stringify(dupInv.get("twin")) === JSON.stringify(["Read", "Grep"]) ||
        JSON.stringify(dupInv.get("twin")) === JSON.stringify(["Read", "Write", "Bash"]),
      `resolved=${JSON.stringify(dupInv.get("twin"))}`,
      "documents last-writer-wins: this is WHY the finding exists");

    const hit = L.detectShadowedAgentDispatch({ subagent_type: "twin", prompt: "Investigate." }, dupInv);
    const miss = L.detectShadowedAgentDispatch({ subagent_type: "lone", prompt: "Investigate." }, dupInv);
    const unk = L.detectShadowedAgentDispatch({ subagent_type: "twin", prompt: "Investigate." }, new Map([["twin", ["Read"]]]));
    check("39e", "DISPATCH firing pole: a dispatch to the shadowed name yields a finding",
      !!hit && hit.rule_id === "agents/agent-definition-shadowing",
      `rule_id=${hit && hit.rule_id}`,
      "M-dup-3: delete detectShadowedAgentDispatch's `shadowed.has(agentType)` arm");
    check("39f", "DISPATCH clean pole: a dispatch to a singly-declared name in the same inventory is silent",
      miss === null, `miss=${JSON.stringify(miss)}`,
      "a predicate that fires on every dispatch, which would pass 39e alone");
    check("39g", "DISPATCH fail-open on UNKNOWN: an unscanned map invents no finding",
      unk === null, `unk=${JSON.stringify(unk)}`,
      "reading UNKNOWN as shadowed — a claim about a corpus nobody read");
    // `?.` on purpose: under a mutation that silences the predicate these must report a FAIL row,
    // not throw. A TypeError exits 1 with an EMPTY red-set, which is indistinguishable from an
    // inert mutation and destroys the red-set as evidence (the runner header's M-l lesson).
    check("39h", "the finding is capped at halt-and-report, never block",
      hit?.severity === "halt-and-report", `severity=${hit?.severity}`,
      "raise severity to block");
    check("39i", "the evidence NAMES the resolved tool set, so the reader can see which record won",
      !!hit?.evidence?.includes("MORE THAN ONE file") &&
        (hit.evidence.includes("Read, Grep") || hit.evidence.includes("Read, Write, Bash")),
      "", "strip the resolved-set interpolation");

    // THE STANDING CONSUMER. This is the case that reds if the predicate is re-orphaned: it goes
    // through `inspectDispatch`, the single entry point `dispatch-contract-guard.js` calls, so a
    // future edit that keeps the predicate but drops the wiring cannot pass.
    const viaInspect = L.inspectDispatch("Task", { subagent_type: "twin", prompt: "Investigate." }, dupInv);
    const viaInspectClean = L.inspectDispatch("Task", { subagent_type: "lone", prompt: "Investigate." }, dupInv);
    check("39j", "STANDING CONSUMER: inspectDispatch — the guard's ONLY entry point — surfaces the shadowing finding",
      viaInspect.some((f) => f.rule_id === "agents/agent-definition-shadowing"),
      `ids=${viaInspect.map((f) => f.rule_id).join(",")}`,
      "M-dup-4: remove the detectShadowedAgentDispatch call from inspectDispatch (the re-orphaning mutation)");
    check("39k", "STANDING CONSUMER other pole: a clean dispatch through the same entry point carries NO shadowing finding",
      !viaInspectClean.some((f) => f.rule_id === "agents/agent-definition-shadowing"),
      `ids=${viaInspectClean.map((f) => f.rule_id).join(",")}`,
      "a wiring that pushes the finding unconditionally");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // NEGATIVE CONTROL on the LIVE corpus: the real repo must be shadow-FREE, and the answer must be
  // an empty Set (scanned) rather than null (unknown). This is the arm that would catch a real
  // duplicate landing in `.claude/agents/` — the hygiene defect the predicate exists for.
  const liveDupes = L.duplicateAgentNames(L.readAgentInventory(REPO));
  check("39l", "LIVE corpus is scanned AND shadow-free — an empty Set, never null",
    liveDupes instanceof Set && liveDupes.size === 0,
    `live shadowed=${liveDupes === null ? "UNKNOWN" : [...liveDupes].join(",") || "(none)"}`,
    "plant a second file declaring an existing agent name");
}

// ── 12. severity is capped below `block` ────────────────────────────────────
{
  const a = L.detectNamedDispatchWithoutDelivery({ name: "n", prompt: "Investigate." });
  const b = L.detectWriteTaskToReadOnlyAgent({ subagent_type: "analyst", prompt: "Create the files." }, INV);
  check("40", "MUST-6 finding is halt-and-report, never block",
    a.severity === "halt-and-report", `severity=${a.severity}`, "raise severity to block");
  check("41", "MUST-5 finding is halt-and-report, never block",
    b.severity === "halt-and-report", `severity=${b.severity}`, "raise severity to block");
  check("42", "rule_ids bind to the owning clauses",
    a.rule_id === "orchestrator-context-economy/MUST-6" && b.rule_id === "orchestrator-context-economy/MUST-5",
    `${a.rule_id} / ${b.rule_id}`);
}

// ── 13. the REAL hook boundary (regression lock for the inert-hook bug) ─────
// The 42 cases above exercise the pure library and ALL PASSED while the hook itself was inert:
// `dispatch-contract-guard.js` called JSON.parse() on `readStdinBounded()`'s already-PARSED return,
// threw on every well-formed payload, and fell through to a silent passthrough. A library-only
// fixture set cannot see that seam — it is exactly the `instrument-discipline.md` MUST-6 shape,
// a green whose scope excludes the class under review. These cases drive the hook as the runtime
// does: real child process, real stdin, real stdout contract.
{
  const sb = makeHookSandbox("boundary");
  const fire = (payload) => JSON.parse(spawnHook(sb, JSON.stringify(payload)).stdout);

  const violating = fire({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." },
  });
  const compliant = fire({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "tdd-implementer", prompt: "Create the fixture files. When done, SendMessage the orchestrator." },
  });
  const offTool = fire({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

  const adv = (o) => o?.hookSpecificOutput?.additionalContext || "";

  check("43", "END-TO-END: a violating dispatch produces a NON-EMPTY advisory at the hook boundary",
    adv(violating).length > 0,
    `advisory chars=${adv(violating).length}`,
    "JSON.parse the already-parsed payload (the original inert-hook bug) — this is the ONLY case that reds");
  check("44", "END-TO-END: the advisory names BOTH clauses",
    adv(violating).includes("MUST-6") && adv(violating).includes("MUST-5"),
    "both rule_ids surface");
  check("45", "END-TO-END: a compliant dispatch produces NO advisory",
    adv(compliant) === "", "the silent pole at the real boundary");
  check("46", "END-TO-END: an off-matcher tool produces NO advisory",
    adv(offTool) === "", "belt to the matcher's suspenders");
  check("47", "END-TO-END: every path emits continue:true and exits 0",
    violating.continue === true && compliant.continue === true && offTool.continue === true,
    "never blocks — hook-output-discipline.md MUST-2");
  check("48", "END-TO-END: the advisory states the halt-and-report cap, never 'block'",
    adv(violating).includes("halt-and-report") && !adv(violating).includes('"block"'),
    "severity cap is stated in the emitted text");
}

// ── 14. the WORKDIR-EXISTENCE predicate (the STRUCTURAL, block-grade arm) ───
// Distinct in KIND from cases 01–48 above, and the distinction is the whole reason
// this arm may carry teeth. MUST-5/MUST-6 rest on a lexical read of prose, so
// `hook-output-discipline.md` MUST-2 caps them at halt-and-report. This one rests on
// `fs.existsSync` — a filesystem FACT, the exact class MUST-2 names as block-grade.
//
// The lexical half here is a SCOPE GATE (which token to test), not the VERDICT. It
// cannot produce a block by itself: an over-matched token must ALSO be an absolute
// path AND that path must not exist. That composition is why "no stronger than its
// weakest half" — the reasoning that caps MUST-5 — does not transfer.
{
  const EXISTS = () => true;
  const MISSING = () => false;

  // -- extraction: which tokens are even considered --
  check("49", "an absolute path after `cd` is extracted",
    L.extractDeclaredWorkdirs(materializeFixtureText("STEP 0: cd {{FIXTURE_HOME_V1:MAC}}x/repos/.wt/lane-a then assert")).includes(materializeFixtureText("{{FIXTURE_HOME_V1:MAC}}x/repos/.wt/lane-a")),
    "the STEP-0 shape", "M-f: drop the `cd` anchor");
  check("50", "an absolute path after a `worktree ... at` phrase is extracted",
    L.extractDeclaredWorkdirs("The worktree is ALREADY CREATED and verified at /tmp/wt/lane-b.").includes("/tmp/wt/lane-b"),
    "the prose shape that produced the real incident", "M-g: drop the worktree anchor");
  check("51", "a RELATIVE path is NOT extracted",
    L.extractDeclaredWorkdirs("cd ./scratch/lane-a and work there").length === 0,
    "relative paths resolve against the hook's cwd, not the agent's — undecidable, so fail open",
    "M-h: accept relative paths");
  check("52", "a URL is NOT extracted as a path",
    L.extractDeclaredWorkdirs("see https://example.com/repos/thing for context").length === 0,
    "the `//` after a scheme must not read as a root path", "M-i: drop the URL guard");
  check("53", "an absolute path with NO workdir anchor is NOT extracted",
    L.extractDeclaredWorkdirs("Read /etc/hosts and summarise it.").length === 0,
    "a path merely MENTIONED is not a declared working directory — the scope gate",
    "M-j: extract every absolute path regardless of anchor");
  check("54", "trailing sentence punctuation is stripped from the extracted path",
    L.extractDeclaredWorkdirs("Work only in /tmp/wt/lane-c.").includes("/tmp/wt/lane-c"),
    "a trailing period is prose, not a path component", "M-k: drop the punctuation trim");

  // -- NEGATIVE FENCES: a path the brief tells the lane to AVOID is not a root pin.
  // Both poles run the SAME brief shape and separate ONLY on whether the anchored path
  // sits in a pin or a prohibition, so a check keying on "an absolute path is present"
  // scores them identically and is the instrument these cases exist to refuse.
  // MEASURED live 2026-09-15: both classes emitted `block` on CORRECT briefs, five
  // dispatches refused. `block` is this module's only teeth, so a false positive here is
  // the register operators disable.
  check("54a", "a brace-expanded SIBLING SET is not extracted as a root pin",
    L.extractDeclaredWorkdirs(
      "STEP 0: cd /tmp/wt/lane-f. NEVER cd to /tmp/wt/lane-{a,b,c}"
    ).join("|") === "/tmp/wt/lane-f",
    "ABS_PATH_RX stops at `{`, so the token is the PREFIX `/tmp/wt/lane-` — not a path, " +
      "never existed, and testing it fabricates a missing-path verdict",
    "M-k2: drop the `prompt[start + raw.length] === '{'` guard");
  check("54b", "an anchored path inside a PROHIBITION is not extracted",
    L.extractDeclaredWorkdirs(
      "STEP 0: cd /tmp/wt/lane-f. Never cd to /tmp/wt/lane-zzz"
    ).join("|") === "/tmp/wt/lane-f",
    "`cd` anchors identically in 'cd X' and 'never cd to X'; without a negation arm the " +
      "guard reads a fence as a root pin — independent of braces",
    "M-k3: drop the WORKDIR_PROHIBITION_RX guard");
  // 54a's brief carries BOTH a brace expansion and a prohibition, so the prohibition arm
  // ABSORBS it: dropping the brace guard alone leaves 54a GREEN. MEASURED — M-k2 in
  // isolation produced an EMPTY red-set with the mutation proven to reach the code, and
  // the double mutation reds 54a+54b. Per `instrument-discipline.md` MUST-5(b) an empty
  // red-set resolves nothing, so this case ISOLATES the brace guard: a positive anchor,
  // a brace-expanded SET, and no negation anywhere.
  check("54e", "ISOLATING the brace guard: a brace set under a POSITIVE anchor is not extracted",
    L.extractDeclaredWorkdirs(
      "Work only in /tmp/wt/lane-f, with per-shard build dirs at /tmp/wt/shard-{1,2,3}"
    ).join("|") === "/tmp/wt/lane-f",
    "without this case the brace guard has NO case that reds when it alone is removed — " +
      "54a passes through the prohibition arm instead",
    "M-k2: drop the `prompt[start + raw.length] === '{'` guard");
  // -- TOKEN CONTINUATION (2026-10-16): a false `block` on a correct brief. The brief pinned a real
  // worktree with a STEP-0 assertion, and `sh "$WT"/lib/x.sh` in its prose yielded the suffix
  // `/lib/x.sh`, which the windowed `worktree`/`cd` gate then tested as the lane root. The fix
  // removes ONE candidate class — a suffix of an unresolved expression — and nothing else, so the
  // 54k cases pin every shape a broader rewrite of the anchoring once let through (each blocks at
  // the prior extractor and must keep blocking).
  const PIN = "/tmp/wt/lane-real";
  const ONLY_PIN = (p) => p === PIN;
  // Each helper reads `missing` ONLY under its own severity, so a case asserting a BLOCK reds when
  // the finding drops to advisory and vice versa (ROOT ruling 2026-10-17: a placeholder-only lane
  // root with no real pin is `advisory`; an absent ABSOLUTE root, or a non-shorthand placeholder
  // beside a real pin, stays `block`).
  const missingAt = (severity) => (prompt, exists = MISSING) => {
    const f = L.detectMissingWorkdirPath({ prompt }, { existsSync: exists });
    return (f && f.severity === severity ? f.missing : []).join("|");
  };
  const blocksOn = missingAt("block");
  const advisesOn = missingAt("advisory");
  const BT = "`";
  [
    ["1", `Worktree: ${PIN}. STEP-0: cd ${PIN} && assert toplevel == pwd -P. In the worktree run ${BT}sh "$WT"/lib/x.sh${BT} and report.`],
    ["2", `Worktree: ${PIN}. STEP-0: cd ${PIN}. In the worktree run sh ${"$"}{WT}/x and report.`],
    ["3", `Worktree: ${PIN}. STEP-0: cd ${PIN}. In the worktree run sh $(pwd)/x and report.`],
    ["4", `Worktree: ${PIN}. STEP-0: cd ${PIN}. In the worktree run sh <wt>/x.sh and report.`],
  ].forEach(([n, prompt]) =>
    check(`54f${n}`, `a TOKEN-CONTINUATION suffix beside a real pin is not a lane root (shape ${n})`,
      blocksOn(prompt, ONLY_PIN) === "",
      "MISSING for everything but the pin, so the case can only stay silent by NOT extracting the suffix",
      n === "4" ? "M-v3-2b: withdraw no placeholder ARGUMENT beside a real pin" : "M-tc: drop the TOKEN_CONTINUATION_RX skip"));
  check("54g", "OTHER POLE — an unfilled `<placeholder>` lane root is REPORTED (named, not by accident; advisory when pure, block with an absolute prefix)",
    advisesOn("Work in the worktree at <scratch>/wt. STEP-0: cd <scratch>/wt and assert toplevel.") === "<scratch>/wt" &&
      blocksOn("STEP 0: cd /tmp/<lane>/wt and assert toplevel.").split("|").includes("/tmp/<lane>/wt") &&
      L.detectMissingWorkdirPath({ prompt: "Work in the worktree at <scratch>/wt. STEP-0: cd <scratch>/wt." })?.severity === "advisory",
    "the third arm uses the REAL resolver, which an unfilled placeholder never reaches: it names no " +
      "location. Before the fix this blocked only because the suffix `/wt` happened not to exist",
    "M-ph: drop the lane-root placeholder candidate (PLACEHOLDER_TOKEN_RX pass 3)");
  check("54h", "a `<placeholder>` used as SHORTHAND for a declared absolute root, or as a return slot, is SILENT",
    blocksOn(`WORKTREE: ${PIN}. STEP 0: cd <worktree>/sub; assert ${BT}git -C <worktree> rev-parse --show-toplevel${BT} equals ${PIN}.`, ONLY_PIN) === "" &&
      blocksOn("Stay in the worktree and return <findings>/<verdict>.") === "" &&
      blocksOn(`Worktree: ${PIN}, report <verdict>.`, ONLY_PIN) === "" &&
      blocksOn("Read-only. If git reports no top level (root = <repo>/.git), say so.") === "",
    "measured on real briefs: a pinned root plus `<worktree>` shorthand, and `<findings>` slots, are the common correct shapes",
    "M-v3-4i: drop the shorthand exception");
  [
    ["1", "STEP 0: cd -- /nope and assert toplevel."],
    ["2", `STEP 0: ${BT}cd -- /nope${BT} and assert toplevel.`],
    ["3", "STEP 0: cd **/nope** and assert toplevel."],
    ["4", "Worktree: **/nope** — work only there."],
    ["5", `Worktree: **${BT}/nope${BT}** — work only there.`],
    ["6", `Worktree: *${BT}/nope${BT}* — work only there.`],
    ["7", `Worktree:\n${BT}${BT}${BT}\n/nope\n${BT}${BT}${BT}\nWork only there.`],
    ["8", `Worktree: ${BT}WT=/nope${BT} then begin.`],
    ["9", `Worktree: ${BT}export WT=/nope${BT}; cd "$WT" and begin.`],
    ["10", `Worktree: ${BT} /nope${BT} then begin.`],
    ["11", `Mind the stray ${BT} here. Worktree: /nope then begin.`],
    ["12", "First cd to the lane dir /nope and begin."],
    ["13", "Then cd into your lane at /nope and begin."],
    ["14", "STEP-0:cd /nope && assert toplevel."],
    ["15", "STEP 0: pushd /nope && assert toplevel."],
  ].forEach(([n, prompt]) =>
    check(`54k${n}`, `OTHER POLE — a dead lane root in pin shape ${n} still BLOCKS`,
      blocksOn(prompt).startsWith("/nope"),
      n === "15" ? "`pushd` is a cd-class anchor (an addition: the prior extractor allowed it)"
        : "a shape a rewrite of the anchoring once let through; the token-continuation skip must not",
      n === "15" ? "M-pd: drop `pushd` from WORKDIR_ANCHOR_RX" : "M-k4"));
  // -- PIN-ANCHOR v3 (2026-10-16): the R2 escapes of v2, each closed by construction. ONE anchor
  // alternation (`WORKDIR_ANCHORS`) builds every anchor test; the continuation skip covers
  // `$`-expressions ONLY, so a `<placeholder>` path is read WHOLE; a placeholder may abbreviate a
  // real root only when a pin-class anchor (`Worktree:`, `working directory`) pins one, never an
  // incidental `cd`/`checkout`; and `..` after a placeholder never counts as shorthand.
  [
    ["1", "Work only in <wt>/lane and report.", "<wt>/lane"],
    ["2", "Work from <wt>/lane and report.", "<wt>/lane"],
    ["3", "The lane is rooted at <scratch>/wt; begin.", "<scratch>/wt"],
    ["4", "Your checkout is located at <scratch>/wt; begin.", "<scratch>/wt"],
    ["5", "Repository at <scratch>/wt; begin.", "<scratch>/wt"],
  ].forEach(([n, prompt, want]) =>
    check(`54m${n}`, `R2-HIGH: an anchor the scope gate holds also makes a lane-root position (shape ${n}; advisory, no pin)`,
      advisesOn(prompt) === want,
      "names the UNRESOLVED placeholder, not the suffix `/lane` the prior extractor tested by accident",
      "M-v3-1: build LANE_ROOT_POSITION_RX from a second, narrower anchor list"));
  [
    ["1", "Worktree: <wt>/lane — work only there. Read /etc/hosts for reference. STEP 0: cd /tmp and run ls."],
    ["2", "Worktree: <wt>/lane — work only there. Also check the checkout /etc/hosts."],
    ["3", "Worktree: <wt>/lane. Repo root (for reference only): checkout at /tmp."],
    ["4", "STEP 0: cd <wt>/lane. Scratch: cd /tmp first."],
  ].forEach(([n, prompt]) =>
    check(`54n${n}`, `R2-MEDIUM: an incidental cd/checkout of a REAL path does not license a placeholder root (shape ${n}; BLOCKS: an absolute lane root is named)`,
      blocksOn(prompt, (p) => p === "/tmp" || p === "/etc/hosts").split("|").includes("<wt>/lane"),
      "only a pin-class anchor (`Worktree:`/`working directory`) may name the root a placeholder abbreviates",
      "M-v3-3: let any anchored absolute path count as the pin"));
  check("54n5", "R2-MEDIUM: an assignment inside the pin (`WT=<wt>/lane`) is a lane-root position (advisory, no real pin)",
    advisesOn(`Worktree: ${BT}WT=<wt>/lane${BT} then begin.`) === "<wt>/lane" &&
      advisesOn(`Worktree: ${BT}export WT=<wt>/lane${BT} then begin.`) === "<wt>/lane",
    "`=` ends the placeholder token and a `NAME=` is a connector, so the value is read as the root",
    "M-v3-eq: let `=` continue a placeholder token");
  check("54n6", "a placeholder ROOT that is not shorthand blocks even beside a real pin",
    blocksOn(`Worktree: ${PIN}. Work only in /tmp/<lane>/wt.`, ONLY_PIN) === "/tmp/<lane>/wt" &&
      blocksOn(`Worktree: ${PIN}. STEP 0: cd <a>/<b>/nope.`, ONLY_PIN) === "<a>/<b>/nope",
    "an absolute prefix or a second placeholder is not an abbreviation of the pinned root",
    "M-v3-3b: treat every lane-root placeholder as shorthand when a pin exists");
  [
    ["1", `Worktree: ${PIN}. STEP 0: cd <wt>/../../nope and assert toplevel.`, "<wt>/../../nope"],
    ["2", `Worktree: ${PIN}. STEP 0: cd <wt>/.. and assert toplevel.`, "<wt>/"],
    ["3", "STEP 0: cd <wt>/../../nope and assert toplevel.", "<wt>/../../nope"],
  ].forEach(([n, prompt, want]) =>
    check(`54p${n}`, `R2-LOW: \`..\` after a placeholder in lane-root position ${n === "3" ? "is REPORTED (advisory: no pin)" : "BLOCKS"} (shape ${n})`,
      (n === "3" ? advisesOn : blocksOn)(prompt, ONLY_PIN) === want,
      "a climb out of the pinned root is not an abbreviation of it; tested on the RAW token, so a " +
        "trailing `..` the punctuation trim strips still counts",
      n === "3" ? "M-ph (no pin: the placeholder blocks without the climb test)" : "M-v3-4: drop the `..` segment test in isPinShorthand"));
  check("54h5", "a pin with a parenthetical aside still PINS the real root its shorthand abbreviates",
    blocksOn(`WORKTREE (created for you, detached, no branch): ${PIN}. STEP 0: cd <wt>/sub && assert toplevel.`, ONLY_PIN) === "",
    "MEASURED on a real brief 2026-10-16: the aside sits between the pin anchor and the path",
    "M-v3-6: make `(` a one-character connector again (drop the aside)");
  check("54q1", "a BARE placeholder lane root with NO pin is REPORTED (advisory)",
    advisesOn("STEP 0: cd <worktree> && assert toplevel.") === "<worktree>",
    "nothing will ever fill it, and no real root is pinned for it to abbreviate",
    "M-v3-2c: require a separator in a placeholder token");
  // -- PLACEHOLDER-ONLY LANE ROOT ⇒ ADVISORY (ROOT ruling 2026-10-17). With no real absolute pin
  // anywhere in the brief, a placeholder lane root is a TEXT reading — nothing was measured — and
  // hook-output-discipline MUST-2 lets only a parsed structural signal block. Each shape asserts
  // the severity AND that nothing reaches the guard as `block`; 54s4/54s5 are the poles that keep
  // the structural blocks (an absent ABSOLUTE root; a non-shorthand placeholder beside a real pin).
  [
    ["1", "STEP 0: cd <worktree> && assert toplevel.", "<worktree>"],
    ["2", "Worktree: <wt>/lane — work only there.", "<wt>/lane"],
  ].forEach(([n, prompt, want]) => {
    const f = L.detectMissingWorkdirPath({ prompt }, { existsSync: MISSING });
    const viaInspect = L.inspectDispatch("Agent", { prompt }, INV, { existsSync: MISSING });
    check(`54s${n}`, `a placeholder-ONLY lane root with no real pin is ADVISORY, never block (shape ${n})`,
      f?.severity === "advisory" && f.rule_id === "agents/worktree-orchestration-absolute-path-pin" &&
        f.missing.join("|") === want && blocksOn(prompt) === "" &&
        !viaInspect.some((x) => x.severity === "block") &&
        viaInspect.some((x) => x.severity === "advisory" && x.rule_id === f.rule_id),
      `severity=${f?.severity} missing=${f?.missing?.join("|")}`,
      "M-adv-A: restore `block` for the placeholder-only lane root");
  });
  check("54s3", "OTHER POLE — an absolute prefix FUSED to a placeholder is an absolute lane root: it BLOCKS",
    blocksOn("STEP 0: cd /tmp/<lane>/wt and assert toplevel.") === "/tmp/<lane>/wt",
    "the downgrade covers a PURE placeholder only; an absolute component disqualifies it (R1 ruling 2026-10-17)",
    "M1: revert the gate to the 0036919dc predicate (no absent absolute root and no pin-class pin)");
  // -- R1 ESCAPES (security R1 2026-10-17, refuting 0036919dc). The downgrade keyed on "no absent
  // absolute root and no pin-class pin", so (MED) an EXISTING absolute path named by a non-pin
  // anchor, or by a pin anchor with intervening words, and (LOW) an absolute prefix fused to a
  // placeholder — read whole as ONE placeholder token and never sent to the filesystem — each
  // dropped a placeholder lane root to advisory. ANY absolute lane root now keeps the block.
  const ALL_EXIST = (p) => !/[<>]/.test(p);
  [
    ["1", "STEP 0: cd <wt>/lane. Scratch: cd /tmp first."],
    ["2", "Worktree: <wt>/lane. Also look at the checkout /tmp first."],
    ["3", "STEP 0: cd <wt>/lane. Work in /tmp for scratch."],
    ["4", "STEP 0: cd <wt>/lane. The repo is rooted at /tmp, for reference."],
    ["5", "STEP 0: cd <wt>/lane. The primary is located at /tmp, for reference."],
    ["6", "STEP 0: cd <wt>/lane. Its repo at /tmp, for reference."],
    ["7", "Worktree for this lane, as created by the orchestrator, is at /tmp. STEP 0: cd <wt>/lane."],
  ].forEach(([n, prompt]) =>
    check(`54t${n}`, `R1-MED: an EXISTING absolute lane root beside a placeholder root keeps the BLOCK (shape ${n})`,
      blocksOn(prompt, ALL_EXIST) === "<wt>/lane" && advisesOn(prompt, ALL_EXIST) === "",
      "every absolute path EXISTS, so the case can only block on the placeholder root — never on a measured absence",
      "M1: revert the gate to the 0036919dc predicate (no absent absolute root and no pin-class pin)"));
  [
    ["8", "STEP 0: cd /tmp/<lane>/wt and assert toplevel.", "/tmp/<lane>/wt"],
    ["9", "Worktree: /tmp/<lane> — work only there.", "/tmp/<lane>"],
    ["10", "STEP 0: cd C:\\wt\\<lane> and assert toplevel.", "C:\\wt\\<lane>"],
  ].forEach(([n, prompt, want]) =>
    check(`54t${n}`, `R1-LOW: an absolute prefix FUSED to a placeholder is never disk-checked, yet keeps the BLOCK (shape ${n})`,
      blocksOn(prompt, ALL_EXIST) === want && advisesOn(prompt, ALL_EXIST) === "",
      "the whole token is ONE placeholder, so no resolver answer can reach it; its absolute prefix alone decides",
      "M1: revert the gate to the 0036919dc predicate (no absent absolute root and no pin-class pin)"));
  // -- R2 ESCAPES (R2 ruling 2026-10-17, F1 + F2). (F1) a `<…>` whose inside opens with a drive
  // letter or a URL scheme wraps a LOCATION, so it is not a pure placeholder; (F2) a home- or
  // UNC-rooted lane root names a location the filesystem is never asked about. Either keeps the block.
  [
    ["1", "STEP 0: cd <C:/wt/lane> and assert toplevel.", "<C:/wt/lane>"],
    ["2", "STEP 0: cd <C:\\wt\\lane> and assert toplevel.", "<C:\\wt\\lane>"],
    ["3", "Worktree: <file:///tmp/wt> — work only there.", "<file:///tmp/wt>"],
  ].forEach(([n, prompt, want]) =>
    check(`54u${n}`, `R2-F1: a placeholder wrapping a drive letter or URL scheme is not PURE: it BLOCKS (shape ${n})`,
      blocksOn(prompt, ALL_EXIST) === want && advisesOn(prompt, ALL_EXIST) === "",
      "the token is read whole and never disk-checked; the location inside the brackets alone decides",
      "M-F1: drop the LOCATION_PLACEHOLDER_RX test from isPurePlaceholder"));
  [
    ["4", "STEP 0: cd <wt>/lane. Scratch: cd ~/scratch first."],
    ["5", "STEP 0: cd <wt>/lane. Work in $HOME/scratch for scratch."],
    ["6", "STEP 0: cd <wt>/lane. The repo is rooted at ${HOME}/repos, for reference."],
    ["7", "STEP 0: cd <wt>/lane. Its repo at \\\\fileserver\\share\\repo, for reference."],
  ].forEach(([n, prompt]) =>
    check(`54u${n}`, `R2-F2: a home- or UNC-rooted lane root beside a placeholder root keeps the BLOCK (shape ${n})`,
      blocksOn(prompt, ALL_EXIST) === "<wt>/lane" && advisesOn(prompt, ALL_EXIST) === "",
      "the home/UNC root is never sent to the resolver, so only its being NAMED can keep the block",
      "M-F2: drop the namesHomeOrUncLaneRoot term from placeholderOnly"));
  check("54u8", "OTHER POLE — a home root after a PROHIBITION word is not a lane root: the placeholder root stays ADVISORY",
    advisesOn("STEP 0: cd <wt>/lane. NEVER cd ~/scratch.", ALL_EXIST) === "<wt>/lane" &&
      blocksOn("STEP 0: cd <wt>/lane. NEVER cd ~/scratch.", ALL_EXIST) === "",
    "unchanged by design (R2 ruling): a path after a prohibition word is not a lane root",
    "M-F2w: drop the prohibition fence from namesHomeOrUncLaneRoot");
  check("54s4", "OTHER POLE — no pin, a placeholder root AND an absent ABSOLUTE root: the filesystem fact BLOCKS",
    blocksOn("STEP 0: cd <wt>/lane. Then cd /nope and run ls.").split("|").includes("/nope"),
    "the advisory downgrade covers a brief whose ONLY missing roots are placeholders; a measured absence keeps `block`",
    "M-adv-B: downgrade the absolute-missing block to advisory");
  check("54s5", "OTHER POLE — a non-shorthand placeholder root beside a REAL pin still BLOCKS",
    blocksOn(`Worktree: ${PIN}. STEP 0: cd <wt>/../../nope and assert toplevel.`, ONLY_PIN) === "<wt>/../../nope",
    "the pin is a parsed structural fact; the ruling keeps every real-pin escape at `block`",
    "M-adv-A2: downgrade every placeholder-only missing set to advisory, pin or not");
  check("54q2", "NARROW continuation: a placeholder ARGUMENT with no pin keeps the prior extractor's reading",
    blocksOn("In the worktree run sh <wt>/x.sh and report.") === "/x.sh",
    "only `$`-expressions are skipped; a `<placeholder>` suffix is withdrawn ONLY beside a real pin " +
      "(54f4) — without one the verdict is exactly the prior one",
    "M-v3-2: re-add the `<placeholder>` arm to TOKEN_CONTINUATION_RX");
  {
    // LINEAR TIME. v2's placeholder tail nested `[…]+` inside `(…)*`: 16 separators cost 27 s
    // (R2, measured). Run in a WORKER with a hard wait so a regressed regex reds this case
    // instead of hanging the runner; the far `cd` sits inside the lookback and the near one keeps
    // the scope gate open, so the lane-root test MUST walk all 100 separators and fail.
    const seps = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? ":" : " ")).join("");
    const prompt = `cd${seps}cd x <a>/b`;
    const sab = new SharedArrayBuffer(8);
    const cell = new Int32Array(sab);
    const w = new Worker(
      "const { workerData: d } = require('node:worker_threads');" +
        "const L = require(d.lib); const t0 = process.hrtime.bigint();" +
        "L.detectMissingWorkdirPath({ prompt: d.prompt }, { existsSync: () => false });" +
        "const a = new Int32Array(d.sab); a[1] = Number((process.hrtime.bigint() - t0) / 1000n);" +
        "Atomics.store(a, 0, 1); Atomics.notify(a, 0);",
      { eval: true, workerData: { lib: path.join(REPO, ".claude/hooks/lib/dispatch-contract.js"), prompt, sab } });
    const waited = Atomics.wait(cell, 0, 0, 5000);
    w.terminate();
    w.unref();
    const us = cell[1];
    check("54r", "LINEAR TIME: 100 mixed separators between anchors return within 50 ms",
      cell[0] === 1 && us < 50000,
      `wait=${waited} elapsed_us=${cell[0] === 1 ? us : "none (5 s wait expired)"}`,
      "M-v3-5: nest `+` inside the connector repetition");
  }
  check("54c", "OTHER POLE — a genuinely absent root pin STILL fires (the fix is not a mute)",
    !!L.detectMissingWorkdirPath(
      { prompt: "STEP 0: cd /tmp/wt/definitely-not-here and assert toplevel." },
      { existsSync: MISSING }
    ),
    "the two guards above must narrow the extractor, never disarm the arm — this is the " +
      "case that fails if a future 'fix' suppresses the finding wholesale",
    "M-k4: make extractDeclaredWorkdirs return [] unconditionally");
  check("54d", "OTHER POLE — an absent pin fires even when the brief ALSO carries a prohibition",
    !!L.detectMissingWorkdirPath(
      {
        prompt:
          "STEP 0: cd /tmp/wt/definitely-not-here and assert. Separately: never touch sibling lanes.",
      },
      { existsSync: MISSING }
    ),
    "the prohibition arm is windowed to the anchor, so an unrelated negation elsewhere in " +
      "the brief must not launder a genuinely dead pin",
    "M-k5: apply WORKDIR_PROHIBITION_RX globally instead of to the anchor window");

  // -- the verdict, with an INJECTED existsSync so the case is hermetic --
  const brief = { prompt: "STEP 0: cd /tmp/definitely-not-here/lane and assert toplevel." };
  check("55", "a NON-EXISTENT declared workdir FIRES",
    !!L.detectMissingWorkdirPath(brief, { existsSync: MISSING }),
    "the accept pole — this is incident #2", "M-l: delete the predicate");
  check("56", "an EXISTING declared workdir is SILENT",
    L.detectMissingWorkdirPath(brief, { existsSync: EXISTS }) === null,
    "the no-false-positive pole — without it, a detector that fires on everything passes case 55",
    "M-m: invert the existsSync test");
  check("57", "a brief naming NO workdir is SILENT (fail open)",
    L.detectMissingWorkdirPath({ prompt: "Summarise the scheduler." }, { existsSync: MISSING }) === null,
    "nothing measured ⇒ nothing claimed", "M-j");
  check("58", "an unparseable/absent brief is SILENT, not a throw",
    L.detectMissingWorkdirPath(null, { existsSync: MISSING }) === null &&
      L.detectMissingWorkdirPath({ prompt: 123 }, { existsSync: MISSING }) === null,
    "fail open on garbage (cc-artifacts.md Rule 7)", "let the throw escape");
  check("59", "an existsSync that THROWS fails OPEN",
    L.detectMissingWorkdirPath(brief, { existsSync: () => { throw new Error("EACCES"); } }) === null,
    "a guard that cannot measure must not block", "M-n: let the fs throw escape");

  // -- the creation-withdrawal arm: a path the brief says will be CREATED --
  check("60", "`git worktree add` in the brief WITHDRAWS the finding",
    L.detectMissingWorkdirPath(
      { prompt: "git worktree add -b b /tmp/new/lane origin/main, then cd /tmp/new/lane" },
      { existsSync: MISSING }) === null,
    "the brief creates it before entering it — not a dead spawn",
    "M-o: delete the creation-withdrawal arm");
  check("61", "`mkdir -p` in the brief WITHDRAWS the finding",
    L.detectMissingWorkdirPath(
      { prompt: "mkdir -p /tmp/new/out then cd /tmp/new/out" },
      { existsSync: MISSING }) === null,
    "same class", "M-o");
  check("62", "without a creation phrase the SAME brief DOES fire",
    !!L.detectMissingWorkdirPath({ prompt: "then cd /tmp/new/lane" }, { existsSync: MISSING }),
    "the withdrawal must be phrase-driven, not unconditional — M-o inverted",
    "M-o inverted: make the withdrawal unconditional");

  // -- severity + attribution --
  // NULL-SAFE by construction (`f?.`). An earlier draft dereferenced `f` directly, so a mutation
  // that deleted the predicate CRASHED the runner at this line instead of failing cases 63–66 —
  // still a red, but an uninformative one that masked which OTHER cases the mutation reddened.
  // Measured, not predicted: M-l / M-m / M-o each produced `<runner crashed before reporting>`
  // in the mutation matrix until this was hardened.
  {
    const f = L.detectMissingWorkdirPath(brief, { existsSync: MISSING });
    check("63", "the workdir finding is severity `block` (structural, not lexical)",
      f?.severity === "block", `severity=${f?.severity}`,
      "M-p: downgrade to halt-and-report — would make the teeth unreachable");
    check("64", "the workdir finding attributes to agents.md § Worktree Orchestration",
      f?.rule_id === "agents/worktree-orchestration-absolute-path-pin",
      `rule_id=${f?.rule_id}`,
      "re-homing the attribution silently");
    check("65", "the pre-existing findings KEEP their orchestrator-context-economy attribution",
      L.detectNamedDispatchWithoutDelivery({ name: "n", prompt: "Investigate." })?.rule_id ===
        "orchestrator-context-economy/MUST-6",
      "the new arm must not re-home the old ones", "re-home MUST-6");
    check("66", "the finding NAMES the missing path so the report is actionable",
      (f?.evidence || "").includes("/tmp/definitely-not-here/lane"),
      "evidence carries the measured fact", "blank the path from the evidence");
  }

  // -- inspectDispatch composition --
  check("67", "inspectDispatch surfaces the workdir finding alongside the lexical ones",
    L.inspectDispatch("Agent",
      { name: "lane-a", prompt: "cd /tmp/definitely-not-here/lane and investigate." },
      INV, { existsSync: MISSING }).some((f) => f.severity === "block"),
    "composition", "M-l");
  // BIPOLAR ON THE REAL FS, deliberately. An earlier draft asserted only
  // `.every(f => f.severity !== "block")` against an EXISTING path — which an EMPTY findings
  // array satisfies vacuously, so it would have passed against a deleted predicate. Both poles
  // are driven through the DEFAULT resolver: one path that exists, one that cannot.
  check("68", "inspectDispatch defaults to the REAL fs (bipolar: existing→silent, missing→block)",
    L.inspectDispatch("Agent", { prompt: `cd ${REPO} and read the rules.` }, INV).length === 0 &&
      L.inspectDispatch("Agent",
        { prompt: `cd /nonexistent-loom-probe-${process.pid}/x and read the rules.` }, INV)
        .some((f) => f.severity === "block"),
    "the positive control: the default resolver is live AND returns both answers",
    "M-q: default existsSync to a constant — either constant fails one pole");
}

// ── 15. the OVERRIDE GATE at the real hook boundary ─────────────────────────
// The root cause this change treats: detection was never the gap. The MUST-5 finding
// FIRED on the real incident and was waved past with "right as issued" — which cost
// nothing and left no record. These cases lock in that an override is now (a) possible,
// (b) ONE-SHOT, and (c) RECORDED.
{
  const G = L;
  const sb = makeHookSandbox("override");
  const RECEIPT = sb.receipt;

  // CONTAINMENT. Every spawn below runs in `sb`, a runner-created mkdtemp project dir (see the
  // HOOK-SPAWN SANDBOX block at the top), so the receipts these cases write and consume never touch
  // the checkout, and no `.claude/dispatch-authz/` directory is ever created there. That also retires
  // the earlier trace problem this block used to manage by hand: `putReceipt`'s recursive mkdir
  // created the DIRECTORY under the checkout, which `detection-binding-check.test.mjs` then red on
  // (`["dispatch-authz"] classified neither as a binding namespace nor as declared non-binding`).
  // The sandbox is removed on exit, so there is no pre-existed/rmdir bookkeeping left to get wrong.

  // A clean start: neither channel armed (`spawnHook` strips the env var), no receipt in the sandbox.
  // Receipts are bound to ONE dispatch; `putReceipt` defaults to the digest of `missingBrief` below.
  const clearReceipt = () => { try { fs.rmSync(RECEIPT, { force: true }); } catch {} };
  let DIGEST_MISSING = null;
  const putReceipt = (reason, digest = DIGEST_MISSING, writtenAt) => {
    fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
    fs.writeFileSync(RECEIPT, receiptLine(digest, reason, writtenAt));
  };

  /** Drive the hook as the runtime does, tolerating a NON-ZERO (blocking) exit. */
  const fireRaw = (payload, extraEnv = {}) => {
    const r = spawnHook(sb, JSON.stringify(payload), extraEnv);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const ctx = (o) => o.json?.hookSpecificOutput?.additionalContext || "";

  const MISSING_PATH = "/tmp/loom-fixture-absent-" + process.pid + "/lane";
  const missingBrief = {
    hook_event_name: "PreToolUse", tool_name: "Agent",
    session_id: "fixture-session", agent_id: "fixture-agent", agent_type: "fixture-worker", tool_use_id: "fixture-call",
    tool_input: { subagent_type: "general-purpose", prompt: `STEP 0: cd ${MISSING_PATH} then work there. Report back via SendMessage.` },
  };
  const presentBrief = {
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: `STEP 0: cd ${sb.dir} then work there. Report back via SendMessage.` },
  };
  DIGEST_MISSING = documentedDigest(missingBrief, [BLOCK_RULE]);

  // WHICH block. Since effort routing (2026-10-12) a second block-class rule exists, and a bare
  // "exit 2 / deny" is satisfied by EITHER; these cases are about the WORKDIR rule, so each asserts
  // the reason names that rule and does NOT name the effort rule.
  const workdirOnly = (o) => {
    const t = String(o.stderr || "") + JSON.stringify(o.json || {});
    return t.includes(BLOCK_RULE) && !t.includes("agents/effort-routing");
  };
  clearReceipt();
  const blocked = fireRaw(missingBrief);
  check("69", "END-TO-END: a non-existent declared workdir BLOCKS (exit 2) — on the workdir rule, not effort routing",
    blocked.status === 2 && workdirOnly(blocked), `exit=${blocked.status} workdirOnly=${workdirOnly(blocked)}`,
    "M-l / M-p — the teeth. This is the case that could not exist before this change.");
  check("70", "END-TO-END: the block payload denies the call",
    blocked.status === 2 && blocked.json?.continue !== false &&
      blocked.json?.hookSpecificOutput?.permissionDecision === "deny" &&
      String(blocked.json?.hookSpecificOutput?.permissionDecisionReason || "").includes(BLOCK_RULE) &&
      !String(blocked.json?.hookSpecificOutput?.permissionDecisionReason || "").includes("agents/effort-routing"),
    `continue=${blocked.json?.continue}`, "M-p");
  check("71", "END-TO-END: the block names the missing path and the override escape",
    (blocked.stderr + JSON.stringify(blocked.json)).includes(MISSING_PATH) &&
      (blocked.stderr + JSON.stringify(blocked.json)).includes(G.OVERRIDE_RECEIPT_REL) && workdirOnly(blocked),
    "a block with an unreachable escape is the MUST NOT this answers",
    "drop the receipt path from the block body");
  check("71a", "END-TO-END: the block PRINTS this dispatch's call digest — the one the documented serialization gives",
    printedDigest(blocked.stderr) === DIGEST_MISSING &&
      printedDigest(blocked.json?.hookSpecificOutput?.permissionDecisionReason) === DIGEST_MISSING,
    `printed=${String(printedDigest(blocked.stderr)).slice(0, 12)} documented=${DIGEST_MISSING.slice(0, 12)}`,
    "M-DIGEST-INPUTS: digest promptOf (prompt+description) or the non-block ids — the printed receipt then lifts nothing");

  const permitted = fireRaw(presentBrief);
  check("72", "END-TO-END: an EXISTING declared workdir is permitted, exit 0",
    permitted.status === 0 && permitted.json?.continue === true,
    `exit=${permitted.status}`,
    "M-m — the no-false-positive pole at the real boundary");

  // NON-BLOCKING RENDER RATIONALE. The tier's `why` explains to the agent WHY nothing was stopped,
  // and that explanation is a CLAIM ABOUT THIS GUARD's own severity model — `zero-tolerance.md`
  // Rule 3e territory, and untested until now. It read "Every finding on this tier reads the
  // brief's PROSE", which was true of all five original predicates and was FALSIFIED the moment a
  // STRUCTURAL predicate (agent-definition shadowing) joined the tier: that one could carry teeth
  // and declines them, which is a choice, not a MUST-2 cap. A rendered rationale that over-explains
  // is how an agent learns the wrong rule from a correct finding.
  const named = fireRaw({
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { name: "lane-x", subagent_type: "general-purpose", prompt: "Investigate the parser." },
  });
  check("72a", "NON-BLOCK RENDER: a halt-and-report-only dispatch is NOT stopped (exit 0, continue true)",
    named.status === 0 && named.json?.continue === true && ctx(named).includes("orchestrator-context-economy/MUST-6"),
    `exit=${named.status}`, "the precondition for 72b — without a finding the render never runs");
  check("72b", "NON-BLOCK RENDER: the rationale distinguishes the MUST-2 CAP from the declined-teeth CHOICE",
    ctx(named).includes("is a CAP") && ctx(named).includes("a deliberate CHOICE, not a cap") &&
      !ctx(named).includes("Every finding on this tier reads the brief's PROSE"),
    "", "M-dup-5: restore the blanket 'every finding reads PROSE' rationale, which the structural predicate falsifies");

  // PLACEHOLDER-ONLY LANE ROOT at the real boundary (ROOT rulings 2026-10-17): the library's
  // `advisory` verdict must reach the agent as a rendered advisory line and must NOT stop the call.
  const placeholderOnly = fireRaw({
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { subagent_type: "general-purpose", prompt: "STEP 0: cd <wt>/lane then work there. Report back via SendMessage." },
  });
  check("72c", "END-TO-END: a placeholder-ONLY lane root is NOT blocked (exit 0) and renders an advisory line",
    placeholderOnly.status === 0 && placeholderOnly.json?.continue === true &&
      ctx(placeholderOnly).includes("[advisory]") &&
      ctx(placeholderOnly).includes("agents/worktree-orchestration-absolute-path-pin") &&
      ctx(placeholderOnly).includes("<wt>/lane"),
    `exit=${placeholderOnly.status} ctx chars=${ctx(placeholderOnly).length}`,
    "M-adv-A: restore `block` for the placeholder-only lane root (exit 2)");

  // ONE-SHOT: the receipt is honoured exactly once, then the gate re-arms.
  clearReceipt();
  putReceipt("worktree is created by the dispatched agent's own STEP-0 bootstrap");
  const overridden = fireRaw(missingBrief);
  const receiptGone = !fs.existsSync(RECEIPT);
  const reblocked = fireRaw(missingBrief);

  check("73", "END-TO-END: a valid receipt lets the blocked call through",
    overridden.status === 0 && overridden.json?.continue === true,
    `exit=${overridden.status}`, "M-r: ignore the receipt");
  check("74", "END-TO-END: the override is RECORDED with the stated reason",
    ctx(overridden).includes("STEP-0 bootstrap"),
    "the reason is echoed into agent-visible context — this is the 'recorded, not free' property",
    "M-s: honour the receipt without echoing the reason");
  check("75", "END-TO-END: the receipt is CONSUMED (deleted) as it is honoured",
    receiptGone, `gone=${receiptGone}`, "M-t: leave the receipt on disk");
  check("76", "END-TO-END: the very next identical call BLOCKS again",
    reblocked.status === 2 && workdirOnly(reblocked), `exit=${reblocked.status}`,
    "the one-shot property at the real boundary — one override cannot disarm the gate", "M-t");

  // CALL BINDING at the real boundary — a receipt written for dispatch A must not lift dispatch B,
  // must not be SPENT by B, must be NAMED in B's block, and must then still lift A. The pair is
  // bipolar on ONE receipt: a hook that ignores the digest fails 76a/76b, one that refuses every
  // receipt fails 76d.
  const otherBrief = {
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: `STEP 0: cd /tmp/loom-fixture-absent-${process.pid}/other-lane then work there. Report back via SendMessage.`,
    },
  };
  clearReceipt();
  putReceipt("written for the FIRST missing-path dispatch only");
  const bytesA = fs.readFileSync(RECEIPT, "utf8");
  const crossed = fireRaw(otherBrief);
  const crossedText = crossed.stderr + JSON.stringify(crossed.json);
  check("76a", "END-TO-END BINDING: a receipt written for dispatch A does NOT lift dispatch B (B still blocks)",
    crossed.status === 2 && crossed.json?.hookSpecificOutput?.permissionDecision === "deny" && workdirOnly(crossed),
    `exit=${crossed.status}`, "M-BIND: drop the digest comparison — one receipt lifts any blocked dispatch again");
  check("76b", "END-TO-END BINDING: dispatch B does NOT consume A's receipt — present and byte-identical",
    crossed.status === 2 && workdirOnly(crossed) && fs.existsSync(RECEIPT) && fs.readFileSync(RECEIPT, "utf8") === bytesA,
    `present=${fs.existsSync(RECEIPT)}`, "M-BIND / spend the receipt before checking the call");
  check("76c", "END-TO-END BINDING: B's block NAMES the refusal on the agent's channel, and says it was left in place",
    crossedText.includes("RECEIPT-DIGEST-MISMATCH") && crossedText.includes("left in place") && workdirOnly(crossed),
    `named=${crossedText.includes("RECEIPT-DIGEST-MISMATCH")}`,
    "M-SILENT-MISMATCH: refuse quietly — 'your receipt was refused' reads as 'there is no receipt'");
  const liftedA = fireRaw(missingBrief);
  check("76d", "END-TO-END BINDING: the SAME receipt then lifts dispatch A (accept pole on the same bytes)",
    liftedA.status === 0 && ctx(liftedA).includes("written for the FIRST missing-path dispatch only") &&
      !fs.existsSync(RECEIPT),
    `exit=${liftedA.status}`, "M-REFUSE-ALL: a hook that honours no receipt passes 76a-76c and fails here");

  // TTL at the real boundary.
  putReceipt("aged out", DIGEST_MISSING, new Date(Date.now() - 20 * 60 * 1000).toISOString());
  const staleRun = fireRaw(missingBrief);
  check("76f", "END-TO-END TTL: a receipt past its TTL does not lift the call; it is named and left in place",
    staleRun.status === 2 && fs.existsSync(RECEIPT) &&
      (staleRun.stderr + JSON.stringify(staleRun.json)).includes("RECEIPT-STALE"),
    `exit=${staleRun.status} present=${fs.existsSync(RECEIPT)}`, "M-TTL: drop the age check");
  clearReceipt();

  // THE USE LEDGER the honours above wrote — under THIS sandbox's main checkout, one row per honour
  // (73 and 76d), none for the refusals (76a, 76f) or the env channel (77 runs below).
  const ledgerFile = path.join(sb.dir, ".claude", "learning", "override-receipt-uses.jsonl");
  let rows = [];
  try {
    rows = fs.readFileSync(ledgerFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    rows = [];
  }
  check("76e", "END-TO-END LEDGER: exactly one row per honoured receipt, naming this dispatch's digest and channel",
    rows.length === 2 &&
      rows.every((r) => r.digest === DIGEST_MISSING && r.channel === ".claude/dispatch-authz/dispatch-contract-allow" &&
        /^[0-9a-f]{64}$/.test(r.reason_sha256)),
    `rows=${rows.length}`, "M-NOLEDGER: honour without recording — the incident class the ledger closes");
  check("R1-OR-consumer", "dispatch use-ledger rows carry this dispatch consumer identity",
    rows.length === 2 && rows.every((row) => row.consumer?.session_id === "fixture-session" &&
      row.consumer?.agent_id === "fixture-agent" && row.consumer?.agent_type === "fixture-worker" &&
      row.consumer?.tool_use_id === "fixture-call"),
    JSON.stringify(rows.map((row) => row.consumer)), "M-CONSUMER: drop consumer forwarding");

  // The operator/CI env channel.
  clearReceipt();
  const viaEnv = fireRaw(missingBrief, { [G.OVERRIDE_ENV]: "1" });
  check("77", "END-TO-END: the env channel lets the blocked call through",
    viaEnv.status === 0 && viaEnv.json?.continue === true,
    `exit=${viaEnv.status}`, "M-u: delete the env channel");
  check("78", "END-TO-END: the env override is RECORDED, never silent",
    ctx(viaEnv).includes(G.OVERRIDE_ENV),
    "an override that leaves no trace is the failure this change exists to fix", "M-u");

  // An unparseable payload is NO verdict: the launch row is `on_incomplete: "deny"`, so the run
  // boundary (`lib/guard-runner.js::readPayload`) refuses it — inverted by the fail-closed migration
  // (it used to pass, the `{}`-default bypass every deny guard carried).
  clearReceipt();
  const garbage = spawnHook(sb, "not json at all");
  check("79", "END-TO-END: an unparseable payload is REFUSED by the run boundary, exit 2, guard named",
    garbage.status === 2 && /\[guard-runner\] DENY dispatch-contract-guard: dispatch-contract-guard could not read its hook payload/.test(garbage.stderr) &&
      !/"continue"\s*:\s*true/.test(garbage.stdout),
    `exit=${garbage.status}`, "unwrap runGuard (the old readStdinBounded {} default passes it)");

  // The LEXICAL arm must stay below block even when it fires.
  const lexicalOnly = fireRaw({
    hook_event_name: "PreToolUse", tool_name: "Agent",
    tool_input: { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." },
  });
  check("80", "END-TO-END: the LEXICAL arm fires but does NOT block (MUST-2 cap holds)",
    lexicalOnly.status === 0 && lexicalOnly.json?.continue === true && ctx(lexicalOnly).includes("MUST-5"),
    `exit=${lexicalOnly.status}`,
    "M-p inverted: promoting the lexical arm to block would violate hook-output-discipline.md MUST-2");
  // INVERTED 2026-09-12. This case used to assert the halt-and-report response OFFERED the receipt.
  // That offer was the misbinding: nothing on the non-block path consumes a receipt, so one written
  // "to record why" sat until it silently lifted the NEXT, unrelated block. Bipolar with case 71,
  // which pins that the BLOCK response still names the escape.
  check("81", "END-TO-END: the lexical (halt-and-report) response offers NO receipt; the block response still does",
    !ctx(lexicalOnly).includes(G.OVERRIDE_RECEIPT_REL) &&
      (blocked.stderr + JSON.stringify(blocked.json)).includes(G.OVERRIDE_RECEIPT_REL),
    "a receipt nothing on this path consumes would lift the NEXT block under the wrong reason",
    "M-B2: re-offer the receipt on the non-block tier");
  clearReceipt();
}

// ── 16. LANE-ORCHESTRATOR BRIEF WITHOUT PARTITION (wip-discipline MUST-9, advisory) ─────────
// IDENTITY assertions throughout, per `cc-artifacts.md` Rule 9: a firing pole asserts the exact
// rule_id, severity AND missing-element list, and every SILENT pole also asserts its full
// classification record — so a leaf that is silent for the WRONG reason (say the lane gate never
// matched) reds here instead of passing as "silent".
{
  const FX = path.join(REPO, ".claude/audit-fixtures/dispatch-contract");
  const brief = (name) => materializeFixtureText(fs.readFileSync(path.join(FX, `lane-brief-${name}.txt`), "utf8"));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const cls = (namesLane, grantsCommit, leafDenial, role, missing) =>
    ({ namesLane, grantsCommit, leafDenial, role, missing });
  const ALL3 = ["fan-out", "disjoint write sets", "single committer"];
  const NO_SPLIT = ["disjoint write sets", "single committer"];
  const is9 = (f, missing) =>
    !!f && f.rule_id === "wip-discipline/MUST-9" && f.severity === "advisory" && same(f.missing, missing);
  const D = (prompt) => L.detectLaneBriefWithoutPartition({ prompt });
  const C = (prompt) => L.classifyLaneBrief(prompt);
  const LANE = "STEP 0: cd /x/repos/.loom-wt/lane-a first.\n";

  const serial = brief("flag-orchestrator-serial");
  const partitioned = brief("clean-orchestrator-partitioned");
  const leaf = brief("clean-leaf-worker");
  const leafGrant = brief("clean-leaf-worker-grant-shaped");
  const noLane = brief("clean-no-lane");
  const quoted = brief("flag-orchestrator-quoted-leaf-subbrief");
  const quotedOk = brief("clean-orchestrator-quoted-leaf-subbrief-partitioned");

  check("82", "MUST-9: a serial lane-orchestrator brief FIRES with all three elements missing",
    is9(D(serial), ALL3), JSON.stringify(D(serial) && { ...D(serial), evidence: "…" }),
    "M-9e/M-9f/M-9g drop an element test; M-9w unwire");
  check("83", "MUST-9: the advisory NAMES each missing element and cites rules/wip-discipline.md MUST-9",
    ALL3.every((m) => (D(serial)?.evidence || "").includes(m)) &&
      (D(serial)?.evidence || "").includes("rules/wip-discipline.md MUST-9"),
    "evidence carries the finding, not just a rule id");
  check("84", "MUST-9: the serial brief classifies orchestrator (lane named, grant, no denial)",
    same(C(serial), cls(true, true, false, "orchestrator", ALL3)), JSON.stringify(C(serial)));
  check("85", "MUST-9: a PARTITIONED orchestrator brief is SILENT — on COMPLIANCE, not on role",
    D(partitioned) === null && same(C(partitioned), cls(true, true, false, "orchestrator", [])),
    JSON.stringify(C(partitioned)), "M-9c: drop the missing.length gate");
  check("86", "MUST-9: a LEAF worker brief (the shape of this detector's own authoring brief) is SILENT on ROLE",
    D(leaf) === null && same(C(leaf), cls(true, false, true, "leaf", [])),
    JSON.stringify(C(leaf)), "M-9v: drop the leaf-denial veto (role reads none, not leaf)");
  check("87", "MUST-9: a leaf brief carrying a GRANT-SHAPED phrase is still SILENT — the denial VETOES",
    D(leafGrant) === null && same(C(leafGrant), cls(true, true, true, "leaf", [])),
    JSON.stringify(C(leafGrant)), "M-9v");
  check("88", "MUST-9: a brief naming NO lane worktree is SILENT even with a grant and no partition",
    D(noLane) === null && same(C(noLane), cls(false, true, false, "none", [])),
    JSON.stringify(C(noLane)), "M-9l: the lane gate always true");
  {
    const bare = LANE + "Survey the open todos in this lane and list them by age.";
    check("89", "MUST-9: a lane brief with NEITHER grant NOR denial is SILENT (not an orchestrator)",
      D(bare) === null && same(C(bare), cls(true, false, false, "none", [])),
      JSON.stringify(C(bare)), "M-9o: the grant gate always true");
  }
  check("90", "MUST-9 NEAR-MISS: denials inside a QUOTED worker sub-brief do not demote the orchestrator",
    is9(D(quoted), NO_SPLIT) && C(quoted).role === "orchestrator",
    JSON.stringify(C(quoted)), "M-9q: classify the role over the UNSTRIPPED brief");
  check("91", "MUST-9 NEAR-MISS, other pole: the same quoted brief WITH the partition is SILENT",
    D(quotedOk) === null && same(C(quotedOk), cls(true, true, false, "orchestrator", [])),
    JSON.stringify(C(quotedOk)));
  {
    const fenced = quoted
      .replace(/^> (.*)$/gm, "$1")
      .replace("worker brief:\n\n", "worker brief:\n\n```\n")
      .replace("final message.\n\nCollect", "final message.\n```\n\nCollect");
    const dq = quoted.replace(/^> (You EDIT.*)\n> (.*)$/m, '"$1 $2"');
    check("92", "MUST-9: a FENCED worker sub-brief is stripped the same way",
      fenced !== quoted && is9(D(fenced), NO_SPLIT), JSON.stringify(C(fenced)), "M-9q");
    check("93", "MUST-9: a DOUBLE-QUOTED worker sub-brief is stripped the same way",
      dq !== quoted && is9(D(dq), NO_SPLIT), JSON.stringify(C(dq)), "M-9q");
    const unquoted = quoted.replace(/^> /gm, "");
    check("94", "MUST-9: UNQUOTING that sub-brief makes the SAME words the reader's own — a leaf, silent",
      unquoted !== quoted && D(unquoted) === null && C(unquoted).role === "leaf",
      "the stripping is what separates 90 from 94; without it both read leaf");
  }

  // -- the three partition elements, each alone --
  check("95", "element: fan-out alone leaves disjoint write sets + single committer missing",
    same(L.missingPartitionElements("Dispatch agents in parallel, one per item."), NO_SPLIT), "", "M-9e");
  check("96", "element: disjoint write sets alone leaves fan-out + single committer missing",
    same(L.missingPartitionElements("Writing agents take disjoint file sets."), ["fan-out", "single committer"]), "", "M-9f");
  check("97", "element: single committer alone leaves fan-out + disjoint write sets missing",
    same(L.missingPartitionElements("You are the sole committer."), ["fan-out", "disjoint write sets"]), "", "M-9g");
  check("98", "element: the partition contract cited by name + mini-orchestrator is complete",
    same(L.missingPartitionElements("Run as a mini-orchestrator under the partition contract."), []), "");
  check("99", "element: an empty brief is missing all three, in declared order",
    same(L.missingPartitionElements(""), ALL3) && same(L.PARTITION_ELEMENTS, ALL3), "");

  // -- the lane gate --
  check("100", "lane gate: a real sibling path matches (POSIX + Windows); a doc PLACEHOLDER does not",
    L.namesLaneWorktree("cd /x/repos/.loom-wt/lane-a") === true &&
      L.namesLaneWorktree("cd C:\\r\\.loom-wt\\lane-a") === true &&
      L.namesLaneWorktree("a sibling like <parent>/.<slug>-wt/<name>") === false,
    "", "M-9l");
  check("101", "lane gate: a STEP-0 toplevel assertion counts ONLY with its branch half",
    L.namesLaneWorktree("assert `git rev-parse --show-toplevel` equals `pwd -P`") === false &&
      L.namesLaneWorktree("assert `git rev-parse --show-toplevel` and `git rev-parse --abbrev-ref HEAD`") === true,
    "", "M-9b: drop the branch half");

  // -- each LEAF-DENIAL arm, alone, vetoes a granted lane brief --
  const GRANTED = LANE + "You may commit to the lane branch when done. ";
  [
    ["102", "Do not dispatch sub-agents.", "M-9d1"],
    ["103", "No sub-agents for this one.", "M-9d2"],
    ["104", "You edit only the files listed below.", "M-9d3"],
    ["105", "Edit files only.", "M-9d4"],
    ["106", "Do not commit.", "M-9d5"],
    ["107", "No commits from you.", "M-9d6"],
  ].forEach(([id, denial, m]) => {
    const t = GRANTED + denial;
    check(id, `denial arm vetoes on its own: "${denial}"`,
      D(t) === null && same(C(t), cls(true, true, true, "leaf", [])), JSON.stringify(C(t)), m);
  });

  // -- each COMMIT-GRANT arm, alone, makes a lane brief an orchestrator --
  [
    ["108", "You are the sole committer.", ["fan-out", "disjoint write sets"], "M-9a1"],
    ["109", "You are the lane orchestrator.", ALL3, "M-9a2"],
    ["110", "You may commit when each item is green.", ALL3, "M-9a3"],
    ["111", "You have commit authority here.", ALL3, "M-9a4"],
    ["112", "Commit each item on the lane branch.", ALL3, "M-9a5"],
  ].forEach(([id, grant, missing, m]) => {
    const t = LANE + grant;
    check(id, `grant arm on its own: "${grant}"`,
      is9(D(t), missing) && same(C(t), cls(true, true, false, "orchestrator", missing)), JSON.stringify(C(t)), m);
  });

  // -- orchestrator HYGIENE naming a different object must not read as a leaf's denial --
  check("113", "hygiene: \"Never commit to main.\" does NOT veto an orchestrator brief",
    is9(D(LANE + "You are the lane orchestrator. Never commit to main."), ALL3), "", "M-9h");
  check("114", "hygiene: \"Do not commit secrets\" does NOT veto an orchestrator brief",
    is9(D(LANE + "You are the lane orchestrator. Do not commit secrets or .env files."), ALL3), "", "M-9h");

  check("115", "MUST-9 fails OPEN on absent / malformed / empty input",
    L.detectLaneBriefWithoutPartition(null) === null &&
      L.detectLaneBriefWithoutPartition(undefined) === null &&
      L.detectLaneBriefWithoutPartition({ prompt: 123 }) === null &&
      L.detectLaneBriefWithoutPartition({ prompt: "" }) === null,
    "cc-artifacts.md Rule 7");
  check("116", "MUST-9 is capped at advisory: every firing pole in this section is `advisory`",
    [serial, quoted, LANE + "You are the lane orchestrator."].every((t) => D(t)?.severity === "advisory"),
    "prose signal — hook-output-discipline.md MUST-2", "M-9s: raise to halt-and-report");
  check("117", "inspectDispatch SURFACES the MUST-9 finding (wired, not merely written)",
    L.inspectDispatch("Agent", { prompt: serial }, INV, { existsSync: () => true })
      .filter((f) => f.rule_id === "wip-discipline/MUST-9").length === 1,
    "", "M-9w: unwire from inspectDispatch");
  {
    const named = L.inspectDispatch("Agent", { name: "lane-w6", prompt: serial }, INV, { existsSync: () => true })
      .map((f) => f.rule_id);
    check("118", "a NAMED serial lane brief carries MUST-6 and MUST-9 exactly once each",
      same(named, ["orchestrator-context-economy/MUST-6", "wip-discipline/MUST-9"]),
      JSON.stringify(named), "M-9w");
  }
}

// ── 17. MUST-9 at the REAL hook boundary ────────────────────────────────────
// The library cases above cannot see the guard's render path, which is exactly how this guard once
// shipped inert while 42 library cases stayed green (§ 13). The lane fixtures name a path that does
// not exist on this machine, which would route them into the BLOCK tier, so the path token is
// re-pointed at this section's sandbox dir, which exists; the lane gate then holds through the
// fixture's STEP-0 branch assertion (a sandbox dir is never a `-wt` sibling).
{
  const sb = makeHookSandbox("must9");
  const FX = path.join(REPO, ".claude/audit-fixtures/dispatch-contract");
  // ONE interpolation site. `dir` is a parameter rather than a second copy of the token: a
  // duplicated literal is the drift mechanism that lets a case keep asserting against a prompt
  // the substitution no longer reaches.
  const atRepo = (name, dir = sb.dir) =>
    materializeFixtureText(fs.readFileSync(path.join(FX, `lane-brief-${name}.txt`), "utf8"))
      .split(materializeFixtureText("{{FIXTURE_HOME_V1:MAC}}op/repos/.loom-wt/wip-ledger")).join(dir);
  const RECEIPT = sb.receipt;
  const RECEIPT_DIR = path.dirname(RECEIPT);
  const clearReceipt = () => { try { fs.rmSync(RECEIPT, { force: true }); } catch {} };
  const fire = (tool_input) => {
    const r = spawnHook(sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input }));
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "").length;
    return { status: r.status, json, lines, ctx: json?.hookSpecificOutput?.additionalContext || "" };
  };

  try {
    clearReceipt();
    const serial = fire({ subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    check("119", "END-TO-END MUST-9: a serial lane-orchestrator brief is NOT blocked (exit 0, continue:true)",
      serial.status === 0 && serial.json?.continue === true, `exit=${serial.status}`, "M-9s inverted to block");
    check("120", "END-TO-END MUST-9: the advisory names the rule, all three missing elements, and its class",
      ["wip-discipline/MUST-9", "fan-out", "disjoint write sets", "single committer",
        "rules/wip-discipline.md MUST-9", "[advisory]"].every((t) => serial.ctx.includes(t)),
      `ctx chars=${serial.ctx.length}`, "M-9w");
    check("121", "END-TO-END MUST-9: rendered at the PRE-ACTION register — the dispatch has NOT run",
      serial.ctx.startsWith("NOT BLOCKED — the action has NOT run yet."),
      JSON.stringify(serial.ctx.slice(0, 60)), "M-G2: render at `advisory` (\"the action proceeded\" — false here)");
    check("122", "END-TO-END MUST-9: an advisory-only dispatch offers NO override receipt",
      !serial.ctx.includes(L.OVERRIDE_RECEIPT_REL), "nothing to override", "M-G1");

    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const REASON = "operator reason written for a blocked call, not for this advisory";
    fs.writeFileSync(RECEIPT, REASON);
    const withReceipt = fire({ subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    const kept = fs.existsSync(RECEIPT) && fs.readFileSync(RECEIPT, "utf8") === REASON;
    clearReceipt();
    check("123", "END-TO-END MUST-9: an advisory-only dispatch does NOT CONSUME a pending receipt",
      kept && withReceipt.ctx.includes("wip-discipline/MUST-9"), `kept=${kept}`,
      "M-G1: construct the gate on advisory-only findings (the receipt is spent and the notice replaces the advisory)");

    const named = fire({ name: "lane-w6", subagent_type: "general-purpose", prompt: atRepo("flag-orchestrator-serial") });
    // INVERTED 2026-09-12 (see case 81): a non-block response no longer offers the receipt.
    check("124", "END-TO-END: MUST-6 + MUST-9 arrive in ONE response, and that non-block response offers NO receipt",
      named.status === 0 && named.lines === 1 &&
        named.ctx.includes("orchestrator-context-economy/MUST-6") &&
        named.ctx.includes("wip-discipline/MUST-9") &&
        !named.ctx.includes(L.OVERRIDE_RECEIPT_REL),
      `exit=${named.status} lines=${named.lines}`, "never double-fire; M-B2");

    const leaf = fire({ subagent_type: "general-purpose", prompt: atRepo("clean-leaf-worker") });
    // ASSERTS THE ABSENCE IT CLAIMS. Until 2026-09-14 this case tested only
    // `!ctx.includes("wip-discipline/MUST-9")`, so a fixture named CLEAN drew a
    // `worktree-isolation/MUST-10` advisory on EVERY host and the suite still reported green
    // — the brief's containment line carried MUST-10's PIN half with no ASSERTION half, which
    // `fixtureContainmentOf` scores `pin-without-assertion`. MUST-10 is halt-and-report, so
    // exit stayed 0 and nothing surfaced it. A clean pole that cannot detect its own
    // contamination is not a control, so the assertion is now TOTAL silence.
    check("125", "END-TO-END MUST-9: a leaf worker brief draws NO finding AT ALL",
      leaf.status === 0 && leaf.ctx === "" && leaf.json?.continue === true,
      `exit=${leaf.status} continue=${leaf.json?.continue} ctx chars=${leaf.ctx.length}${
        leaf.ctx ? ` ctx=${JSON.stringify(leaf.ctx.slice(0, 400))}` : ""
      }`, "M-9v; drop the brief's STEP-0 assertion half and MUST-10 reappears");
    const ok = fire({ subagent_type: "general-purpose", prompt: atRepo("clean-orchestrator-partitioned") });
    // The detail QUOTES the context rather than counting it. `ctx chars=1904`
    // is a TALLY, and a tally cannot say WHICH predicate spoke — this case
    // failed exactly once, on a CI host, and the log carried only the number,
    // so the finding was undiagnosable from the evidence it produced
    // (`instrument-discipline.md` MUST-3(b): read the hits, not the tally).
    check("126", "END-TO-END MUST-9: a partitioned orchestrator brief is fully SILENT",
      ok.status === 0 && ok.ctx === "" && ok.json?.continue === true,
      `exit=${ok.status} continue=${ok.json?.continue} ctx chars=${ok.ctx.length}${
        ok.ctx ? ` ctx=${JSON.stringify(ok.ctx.slice(0, 400))}` : ""
      }`, "M-9c");

    // ── REGRESSION PIN: the verdict must be a property of the BRIEF, never of the HOST ──
    // `atRepo` interpolates `sb.dir` into the brief, so every word in the runner's TMPDIR
    // reaches predicates that match PROSE. MEASURED: this fleet's self-hosted runner roots
    // TMPDIR under a home directory whose leading segment ENDS IN A BUILD VERB — the literal
    // path is recorded once, on the never-synced surface, at
    // `.claude/test-harness/tests/helpers/sun-path.mjs:13`, and is deliberately NOT reproduced
    // here: this file SHIPS (`audit-fixtures/**` is tier-matched) and an operator-home-shaped
    // path on a synced surface is exactly what the #263 disclosure gate exists to refuse.
    // That segment supplies
    // `\bbuild\b` — `-` and `/` are non-word characters, so both boundaries land — which is the
    // ONE token `detectUnpinnedFixtureDispatch`'s `buildsRepo` conjunction lacked: the NOUN half
    // was ALREADY satisfied on every host by the brief's own `"STOP: not a git repo"`. Case 126
    // therefore drew a `worktree-isolation/MUST-10` advisory on CI and nowhere else, and had sat
    // one token from firing since it landed. The briefs now carry MUST-10's PIN form, so the
    // finding is suppressed on COMPLIANCE rather than on the accident of which words the ambient
    // path happens to contain.
    //
    // The path CANNOT simply be dropped: a brief naming a directory that does not exist routes
    // into the BLOCK tier (see this section's header), which is why it is re-pointed at a real
    // sandbox in the first place. So immunity is asserted instead of assumed — this case rebuilds
    // the CI condition on EVERY host from a real directory whose own name carries the verb as a
    // bounded word. It REDS if any brief loses its containment clause.
    //
    // The `/\bbuild\b/` precondition is load-bearing per `cc-artifacts.md` Rule 9: without it a
    // silent pole would pass when the verb FAILED to reach the prompt, i.e. for the wrong reason.
    // It MUST test the DELIVERED PROMPT, never the directory string it was built from:
    // `path.join(x, "ci-build-home")` always contains `build`, so a precondition reading `verbDir`
    // is a TAUTOLOGY — it cannot return false, and a check that cannot fail is not a control
    // (`instrument-discipline.md` MUST-1). Measured: with the interpolation token drifted, the
    // prompt falls back to the RAW brief (whose "builds" does not match `\bbuild\b`), the detector
    // returns null, ctx is "" — and a verbDir-reading precondition still reports true, passing the
    // case vacuously for exactly the reason this comment claims it prevents.
    const verbDir = path.join(sb.dir, "ci-build-home");
    fs.mkdirSync(verbDir, { recursive: true });
    const verbPrompt = atRepo("clean-orchestrator-partitioned", verbDir);
    const hostShaped = fire({ subagent_type: "general-purpose", prompt: verbPrompt });
    const verbReached = /\bbuild\b/i.test(verbPrompt);
    check("139", "ENV-INDEPENDENCE: a partitioned brief stays SILENT when the sandbox path ITSELF carries a build verb — the verdict is the brief's property, not the host's TMPDIR naming",
      verbReached && hostShaped.status === 0 && hostShaped.ctx === "" &&
        hostShaped.json?.continue === true,
      `verb-in-path=${verbReached} exit=${hostShaped.status} continue=${hostShaped.json?.continue} ctx chars=${hostShaped.ctx.length}${
        hostShaped.ctx ? ` ctx=${JSON.stringify(hostShaped.ctx.slice(0, 400))}` : ""
      }`, "M-10h: drop the brief's CONTAINMENT clause and the ambient path decides the verdict");
  } finally {
    clearReceipt();
  }
}

// ── 18. OVERRIDE BINDING + FULL BLOCK RENDER + RUNNER ISOLATION (2026-09-12) ─
// Two guard defects, each pinned by a bipolar pair with IDENTITY preconditions (each precondition
// asserts the exact severity + rule_id set the library produces for the brief, so a case cannot pass
// because its brief silently stopped drawing the finding it is about):
//   (a) a dispatch whose findings were all non-block RESOLVED the override, consuming a receipt an
//       operator wrote for a blocked call; the blocked call then had none.
//   (b) a BLOCK response rendered only the blocking evidence, dropping every other finding.
// Plus the lock for the HOOK-SPAWN SANDBOX at the top of this file.
{
  const sb = makeHookSandbox("binding");
  const inv = L.readAgentInventory(sb.dir);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const classes = (list) => list.map((f) => `${f.severity} ${f.rule_id}`).sort();
  const fire = (tool_input) => {
    const r = spawnHook(sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input }));
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return {
      status: r.status, json, stderr: r.stderr || "",
      ctx: json?.hookSpecificOutput?.additionalContext || "",
      reason: json?.hookSpecificOutput?.permissionDecisionReason || "",
    };
  };
  const REASON = "operator override written for the BLOCKED lane-b dispatch only";
  // The blocked dispatch the pending receipt is written FOR — declared before the receipt, because
  // a receipt now names its call by digest.
  const BLOCK = {
    subagent_type: "general-purpose",
    prompt: `STEP 0: cd /tmp/loom-fixture-absent-${process.pid}-binding/lane then work there. Report back via SendMessage.`,
  };
  const readReceipt = () => { try { return fs.readFileSync(sb.receipt); } catch { return null; } };
  const putReceipt = () => {
    fs.mkdirSync(path.dirname(sb.receipt), { recursive: true });
    fs.writeFileSync(
      sb.receipt,
      receiptLine(documentedDigest({ tool_name: "Agent", tool_input: BLOCK }, [BLOCK_RULE]), REASON) + "\n",
    );
  };
  const findingLines = (s) => s.split("\n").filter((l) => l.startsWith("- ["));

  // -- (a) pole 1: halt-and-report ONLY, with a receipt pending --
  const HALT = { name: "lane-a", subagent_type: "analyst", prompt: "Create the fixture files. Return your findings." };
  const haltF = L.inspectDispatch("Agent", HALT, inv);
  check("127", "BINDING precondition: the brief under test carries halt-and-report findings ONLY (identity)",
    same(classes(haltF), ["halt-and-report orchestrator-context-economy/MUST-5", "halt-and-report orchestrator-context-economy/MUST-6"]),
    JSON.stringify(classes(haltF)));
  putReceipt();
  const pending = readReceipt();
  const halt = fire(HALT);
  const afterHalt = readReceipt();
  check("128", "BINDING: a halt-and-report-only dispatch leaves a pending receipt PRESENT and BYTE-IDENTICAL",
    pending !== null && afterHalt !== null && Buffer.compare(pending, afterHalt) === 0,
    `after=${afterHalt === null ? "DELETED" : "present"}`, "M-B1: resolve the override on non-block findings");
  check("129", "BINDING: ...records NO override: a NOT-BLOCKED pre-action report of both findings, no reason echoed",
    halt.status === 0 && halt.json?.continue === true &&
      halt.ctx.startsWith("NOT BLOCKED — the action has NOT run yet.") &&
      halt.ctx.includes("- [halt-and-report] orchestrator-context-economy/MUST-5: ") &&
      halt.ctx.includes("- [halt-and-report] orchestrator-context-economy/MUST-6: ") &&
      !halt.ctx.includes("OVERRIDDEN") && !halt.ctx.includes("Override HONOURED") && !halt.ctx.includes(REASON),
    JSON.stringify(halt.ctx.slice(0, 60)), "M-B1");
  check("130", "BINDING: ...and OFFERS no receipt",
    !halt.ctx.includes(L.OVERRIDE_RECEIPT_REL), "", "M-B2: re-offer the receipt on the non-block tier");

  // -- (a) pole 2: the SAME pending receipt meets the blocked call it was written for --
  const blockF = L.inspectDispatch("Agent", BLOCK, inv);
  const overridden = fire(BLOCK);
  const afterBlock = readReceipt();
  check("131", "BINDING other pole: that SAME receipt is CONSUMED by the block dispatch, its reason recorded",
    same(classes(blockF), ["block agents/worktree-orchestration-absolute-path-pin"]) &&
      afterBlock === null && overridden.status === 0 && overridden.json?.continue === true &&
      overridden.ctx.includes("Override HONOURED via one-shot receipt") && overridden.ctx.includes(REASON),
    `exit=${overridden.status} receipt=${afterBlock === null ? "consumed" : "present"}`,
    "without this pole a guard that never honours a receipt passes 128-130");

  // -- (b) block + halt-and-report + advisory on ONE brief, no receipt --
  const MIXED = {
    name: "lane-w6", subagent_type: "general-purpose",
    prompt: materializeFixtureText(fs.readFileSync(path.join(REPO, ".claude/audit-fixtures/dispatch-contract/lane-brief-flag-orchestrator-serial.txt"), "utf8"))
      .split(materializeFixtureText("{{FIXTURE_HOME_V1:MAC}}op/repos/.loom-wt/wip-ledger")).join(`/nonexistent-loom-probe-${process.pid}/repos/.loom-wt/lane-mixed`),
  };
  const mixedF = L.inspectDispatch("Agent", MIXED, inv);
  const mixed = fire(MIXED);
  check("132", "BLOCK RENDER precondition: ONE brief carrying block + halt-and-report + advisory (identity)",
    same(classes(mixedF), [
      "advisory wip-discipline/MUST-9",
      "block agents/worktree-orchestration-absolute-path-pin",
      "halt-and-report orchestrator-context-economy/MUST-6",
    ]),
    JSON.stringify(classes(mixedF)));
  check("133", "BLOCK RENDER: the response is still a BLOCK (exit 2, deny, STOP head — and no halt)",
    mixed.status === 2 && mixed.json?.continue !== false &&
      mixed.json?.hookSpecificOutput?.permissionDecision === "deny" &&
      mixed.reason.startsWith("STOP — Tool call blocked."),
    `exit=${mixed.status}`, "the non-block findings must not soften the block");
  check("134", "BLOCK RENDER: EVERY finding is rendered, one line each, each under its OWN class",
    same(findingLines(mixed.reason).map((l) => l.slice(0, l.indexOf(": "))).sort(),
      mixedF.map((f) => `- [${f.severity}] ${f.rule_id}`).sort()),
    JSON.stringify(findingLines(mixed.reason).map((l) => l.slice(0, 70))),
    "M-B3: drop the non-blocking findings from the block render");
  check("135", "BLOCK RENDER: the stderr delivery channel of a denied call carries the same full list",
    mixedF.length === 3 && mixedF.every((f) => mixed.stderr.includes(`- [${f.severity}] ${f.rule_id}: `)),
    "", "M-B3");
  check("136", "BLOCK RENDER: the report asks for the NON-block findings to be answered, not only the path",
    mixed.reason.includes("Name each NON-block finding's rule_id"), "", "drop the non-block report line");
  const solo = fire(BLOCK);
  check("137", "BLOCK RENDER other pole: a BLOCK-ONLY brief renders exactly its one finding and asks nothing about non-block ones",
    solo.status === 2 && findingLines(solo.reason).length === 1 && blockF.length === 1 &&
      !solo.reason.includes("Name each NON-block finding's rule_id"),
    `exit=${solo.status} lines=${findingLines(solo.reason).length}`,
    "a render that adds phantom lines, or asks about findings that are not there");

  // -- runner isolation: the hook is started from ONE place, and every sandbox is outside the checkout --
  // A call whose first argument is the literal "git" cannot start the hook, so it is not counted:
  // `makeHookSandbox` runs `git init` to give each sandbox its own repository (the use ledger
  // resolves under it). Any other start site — `node`, `process.execPath`, a variable — still counts.
  const SRC = fs.readFileSync(new URL(import.meta.url), "utf8");
  const START_RX = new RegExp("\\b(?:spawnSync|execFileSync|execSync|spawn|execFile|exec|fork)\\((?!\\s*[\"']git[\"'])", "g");
  // The openStdin producer's own start is the ONE spawnHook launches (its hook argv is spawnHook's checked one), so it
  // is counted separately: the rest of the file holds exactly one start site, the producer exactly one.
  const pAt = SRC.indexOf("const OPEN_PRODUCER = [");
  const pEnd = pAt < 0 ? -1 : SRC.indexOf("].join(", pAt);
  const starts = (pEnd < 0 ? SRC : SRC.slice(0, pAt) + SRC.slice(pEnd)).match(START_RX) || [];
  const producerStarts = OPEN_PRODUCER.match(START_RX) || [];
  check("138", "ISOLATION: the hook is started from exactly ONE call site (the sandbox-pinned spawnHook, plus its openStdin producer's single start), and all 4 sandboxes sit outside the checkout",
    pEnd > 0 && starts.length === 1 && producerStarts.length === 1 && sandboxes.length === 4 &&
      sandboxes.every((s) => within(s.dir, TMP_REAL) && !within(s.dir, REPO_REAL)),
    `start sites=${starts.length} producer=${producerStarts.length} sandboxes=${sandboxes.length}`,
    "M-S2: a section that starts the hook directly again");
}

// ── 20. EFFORT ROUTING — every launch carries the effort its ROLE maps to (2026-10-12) ────────
// Owner decision: a subagent launch MUST carry the effort the routing table assigns to its ROLE.
// The table is ONE data file (`hooks/lib/effort-routing-policy.json`); the role is the brief's
// FIRST non-empty line `ROLE: <role>`; an override is the NEXT non-empty line
// `EFFORT-OVERRIDE: <level> — <reason>`. Every verdict compares PARSED fields — the role line, the
// table, the `effort` tool parameter — so the arm is block-grade (hook-output-discipline MUST-2),
// and it FAILS CLOSED: an invalid table, a missing role, an unknown role or a missing effort blocks.
// Placed AFTER case 138 so its new sandboxes do not move 138's sandbox count.
{
  let ER = null;
  try {
    ER = require(path.join(REPO, ".claude/hooks/lib/effort-routing.js"));
  } catch (e) {
    ER = null;
  }
  const has = (name) => ER && typeof ER[name] === "function";
  const codes = (r) => (r && Array.isArray(r.findings) ? r.findings.map((f) => `${f.severity}:${f.code}`).sort() : ["<no result>"]);
  const tableOk = has("loadRoutingTable") ? ER.loadRoutingTable() : null;

  // -- the TABLE: schema-versioned roles -> effort, every value in the five levels --
  check("E01", "the shipped routing table loads VALID, with exactly the owner's nine roles and levels",
    tableOk?.ok === true &&
      JSON.stringify(tableOk.roles) === JSON.stringify({
        "security-review": "high", "correctness-review": "high", "load-bearing-author": "high",
        "bounded-bugfix": "medium", "routine-implementation": "medium", "explore-search": "medium",
        "mechanical-receipt": "low", extraction: "low", "codex-seat": "medium",
      }),
    JSON.stringify(tableOk), "edit a role's level in the table");
  check("E02", "the level vocabulary is exactly {low, medium, high, xhigh, max}",
    ER && JSON.stringify(ER.LEVELS) === JSON.stringify(["low", "medium", "high", "xhigh", "max"]),
    JSON.stringify(ER && ER.LEVELS));
  const validate = (o) => (has("validateRoutingTable") ? ER.validateRoutingTable(o) : { ok: "<missing>" });
  const base = { schema_version: 1, roles: { "security-review": "high" } };
  check("E03", "an UNKNOWN top-level key makes the table INVALID",
    validate({ ...base, extra: true }).ok === false, JSON.stringify(validate({ ...base, extra: true })),
    "drop the unknown-key check");
  check("E04", "an UNKNOWN effort value makes the table INVALID",
    validate({ schema_version: 1, roles: { a: "ultra" } }).ok === false, "", "drop the level check");
  check("E05", "a wrong schema_version makes the table INVALID",
    validate({ ...base, schema_version: 2 }).ok === false, "", "drop the version check");
  check("E06", "an empty roles map, a non-object roles map, and a malformed role name are each INVALID",
    validate({ schema_version: 1, roles: {} }).ok === false &&
      validate({ schema_version: 1, roles: ["high"] }).ok === false &&
      validate({ schema_version: 1, roles: { "Bad Role": "high" } }).ok === false, "");
  check("E07", "the accept pole: a minimal well-formed table (with a _doc array) is VALID",
    validate({ ...base, _doc: ["why"] }).ok === true, JSON.stringify(validate({ ...base, _doc: ["why"] })),
    "a validator that rejects everything");
  const missingFile = has("loadRoutingTable") ? ER.loadRoutingTable(path.join(TMP_REAL, `absent-${process.pid}.json`)) : null;
  check("E08", "an ABSENT table file is INVALID (fail-closed), with a reason, never a default table",
    missingFile?.ok === false && typeof missingFile.reason === "string" && missingFile.reason.length > 0,
    JSON.stringify(missingFile), "fall back to a built-in default table");

  // -- the ROLE line and the override line are PARSED fields at fixed positions --
  const hdr = (t) => (has("parseBriefHeader") ? ER.parseBriefHeader(t) : {});
  check("E09", "the FIRST non-empty line `ROLE: x` is the role; leading blank lines are skipped",
    hdr("\n\n  ROLE: security-review  \nbody").role === "security-review", JSON.stringify(hdr("\n\nROLE: security-review\nbody")));
  check("E10", "a ROLE line that is NOT first is no role (it is prose, not the field)",
    hdr("Please review.\nROLE: security-review").role === null, "", "search every line for ROLE:");
  check("E11", "the override is the NEXT non-empty line, level + em-dash + non-empty reason",
    JSON.stringify(hdr("ROLE: extraction\nEFFORT-OVERRIDE: high — the table is wrong for this one").override) ===
      JSON.stringify({ level: "high", reason: "the table is wrong for this one" }),
    JSON.stringify(hdr("ROLE: extraction\nEFFORT-OVERRIDE: high — the table is wrong for this one")));
  check("E12", "an override with an EMPTY reason or an unknown level is MALFORMED, never honoured",
    hdr("ROLE: extraction\nEFFORT-OVERRIDE: high —   ").overrideError &&
      hdr("ROLE: extraction\nEFFORT-OVERRIDE: turbo — reason").overrideError &&
      hdr("ROLE: extraction\nEFFORT-OVERRIDE: high — x").override?.level === "high", "");

  // -- the launch decision (library) --
  const launch = (prompt, effort) => (has("decideLaunch")
    ? ER.decideLaunch(effort === undefined ? { prompt } : { prompt, effort }, tableOk)
    : null);
  check("E13", "CONTROL: a correct launch (role line + the table's effort) yields NO finding",
    JSON.stringify(codes(launch("ROLE: security-review\nAudit the diff.", "high"))) === "[]",
    JSON.stringify(codes(launch("ROLE: security-review\nAudit the diff.", "high"))), "a decider that always blocks");
  check("E14", "NO ROLE line BLOCKS (ROLE_MISSING), naming every valid role",
    JSON.stringify(codes(launch("Audit the diff.", "high"))) === '["block:ROLE_MISSING"]' &&
      launch("Audit the diff.", "high").findings[0].evidence.includes("security-review (high)") &&
      launch("Audit the diff.", "high").findings[0].evidence.includes("mechanical-receipt (low)"),
    JSON.stringify(codes(launch("Audit the diff.", "high"))), "pass a launch with no role");
  check("E15", "an UNKNOWN role BLOCKS (ROLE_UNKNOWN), naming the valid roles",
    JSON.stringify(codes(launch("ROLE: wizard\nx", "high"))) === '["block:ROLE_UNKNOWN"]' &&
      launch("ROLE: wizard\nx", "high").findings[0].evidence.includes("codex-seat (medium)"),
    JSON.stringify(codes(launch("ROLE: wizard\nx", "high"))), "accept any role string");
  check("E16", "a MISSING effort BLOCKS (EFFORT_MISSING), naming the required level",
    JSON.stringify(codes(launch("ROLE: extraction\nx"))) === '["block:EFFORT_MISSING"]' &&
      launch("ROLE: extraction\nx").findings[0].evidence.includes("effort: low"),
    JSON.stringify(codes(launch("ROLE: extraction\nx"))), "treat a missing effort as the default");
  check("E17", "an effort that differs from the table BLOCKS (EFFORT_MISMATCH), naming the required level",
    JSON.stringify(codes(launch("ROLE: extraction\nx", "high"))) === '["block:EFFORT_MISMATCH"]' &&
      launch("ROLE: extraction\nx", "high").findings[0].evidence.includes("effort: low"),
    JSON.stringify(codes(launch("ROLE: extraction\nx", "high"))), "drop the equality test");
  const ov = launch("ROLE: extraction\nEFFORT-OVERRIDE: high — needs the deeper pass\nx", "high");
  check("E18", "a valid override whose level IS the dispatched effort passes, as an ADVISORY honour carrying the override",
    JSON.stringify(codes(ov)) === '["advisory:OVERRIDE_HONOURED"]' && ov.override?.level === "high" &&
      ov.override?.required === "low" && ov.override?.reason === "needs the deeper pass",
    JSON.stringify({ c: codes(ov), o: ov && ov.override }), "ignore the override line");
  check("E19", "an override whose level is NOT the dispatched effort still BLOCKS",
    JSON.stringify(codes(launch("ROLE: extraction\nEFFORT-OVERRIDE: high — reason\nx", "medium"))) === '["block:EFFORT_MISMATCH"]', "");
  check("E20", "a MALFORMED override line BLOCKS (OVERRIDE_MALFORMED) even when the effort matches the table",
    JSON.stringify(codes(launch("ROLE: extraction\nEFFORT-OVERRIDE: low\nx", "low"))) === '["block:OVERRIDE_MALFORMED"]', "");
  const invalidTable = has("validateRoutingTable") ? ER.validateRoutingTable({ schema_version: 1, roles: { a: "ultra" } }) : null;
  const viaInvalid = has("decideLaunch") ? ER.decideLaunch({ prompt: "ROLE: a\nx", effort: "high" }, invalidTable) : null;
  check("E21", "an INVALID table BLOCKS every launch with a `routing table invalid` reason",
    JSON.stringify(codes(viaInvalid)) === '["block:TABLE_INVALID"]' &&
      viaInvalid.findings[0].evidence.includes("routing table invalid"),
    JSON.stringify(codes(viaInvalid)), "evaluate against an invalid table");

  // -- the RE-TASKING decision (library) --
  const retask = (message, launchState) => (has("decideRetask")
    ? ER.decideRetask({ to: "lane-r", message }, tableOk, launchState)
    : null);
  const KNOWN_HIGH = { state: "known", effort: "high" };
  check("E22", "re-tasking a HIGH-launched agent with a LOW role BLOCKS: dispatch a fresh agent at low",
    JSON.stringify(codes(retask("ROLE: mechanical-receipt\nWrite the receipt.", KNOWN_HIGH))) === '["block:RETASK_EFFORT_MISMATCH"]' &&
      retask("ROLE: mechanical-receipt\nWrite the receipt.", KNOWN_HIGH).findings[0].evidence.includes("dispatch a fresh agent at low"),
    JSON.stringify(codes(retask("ROLE: mechanical-receipt\nx", KNOWN_HIGH))), "drop the re-task comparison");
  check("E23", "CONTROL: re-tasking with a role of the SAME effort passes untouched",
    JSON.stringify(codes(retask("ROLE: correctness-review\nNow check the tests.", KNOWN_HIGH))) === "[]", "");
  check("E24", "a follow-up with NO ROLE line is not a re-tasking declaration and passes untouched",
    JSON.stringify(codes(retask("thanks — also look at line 40", KNOWN_HIGH))) === "[]", "");
  check("E25", "an UNKNOWN launch effort is ADVISORY only, never a block",
    JSON.stringify(codes(retask("ROLE: mechanical-receipt\nx", { state: "unknown", reason: "no launch row" }))) ===
      '["advisory:RETASK_LAUNCH_UNKNOWN"]', "", "block on missing history");
  const lf = (rows, to, gen) => (has("launchEffortFor") ? ER.launchEffortFor(rows, to, gen) : { state: "<missing>" });
  const row = (name, effort, generation = "(main-agent)") => ({ kind: "launch", launch_id: `${name}-${effort}-${Math.random()}`, dispatch_name: name, generation, effort });
  check("E26", "launch effort resolves from the ledger rows of THIS generation, by dispatch name",
    JSON.stringify(lf([row("lane-r", "high"), row("other", "low")], "lane-r", "(main-agent)")) === JSON.stringify({ state: "known", effort: "high" }), "");
  check("E27", "rows that DISAGREE, rows with no effort, and a name never launched are each UNKNOWN",
    lf([row("lane-r", "high"), row("lane-r", "low")], "lane-r", "(main-agent)").state === "unknown" &&
      lf([row("lane-r", undefined)], "lane-r", "(main-agent)").state === "unknown" &&
      lf([row("lane-r", "high", "other-gen")], "lane-r", "(main-agent)").state === "unknown" &&
      lf([], "lane-r", "(main-agent)").state === "unknown", "");

  // -- the REAL hook boundary --
  const sbE = makeHookSandbox("effort");
  // SendMessage goes to the RE-TASK entry (`dispatch-retask-guard.js`), as the registry routes it;
  // every launch goes to the launch entry. `opts.hook` pins one entry explicitly.
  const fireE = (tool_name, tool_input, extra = {}, env = {}, opts = {}) => {
    const hook = opts.hook || (tool_name === "SendMessage" ? RETASK_HOOK : HOOK);
    const r = spawnHook(sbE, JSON.stringify({ hook_event_name: "PreToolUse", tool_name, session_id: "s-effort", tool_input, ...extra }), env, { raw: true, hook });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, stderr: r.stderr || "",
      ctx: json?.hookSpecificOutput?.additionalContext || "",
      reason: json?.hookSpecificOutput?.permissionDecisionReason || "" };
  };
  const good = fireE("Agent", { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit the diff.", effort: "high" });
  check("E30", "END-TO-END CONTROL: a correct launch passes UNTOUCHED (exit 0, no context)",
    good.status === 0 && good.json?.continue === true && good.ctx === "", `exit=${good.status} ctx=${good.ctx.length}`);
  const noRole = fireE("Agent", { subagent_type: "general-purpose", prompt: "Audit the diff.", effort: "high" });
  check("E31", "END-TO-END: a launch with NO ROLE line is BLOCKED (exit 2, deny), naming the valid roles",
    noRole.status === 2 && noRole.json?.hookSpecificOutput?.permissionDecision === "deny" &&
      noRole.reason.includes("agents/effort-routing") && noRole.reason.includes("ROLE_MISSING") && noRole.reason.includes("security-review (high)"),
    `exit=${noRole.status}`, "the guard never consults the routing arm");
  const mism = fireE("Task", { subagent_type: "general-purpose", prompt: "ROLE: mechanical-receipt\nWrite it.", effort: "high" });
  check("E32", "END-TO-END: an effort that differs from the table is BLOCKED, naming the required effort",
    mism.status === 2 && mism.reason.includes("effort: low"), `exit=${mism.status}`);
  const noEffort = fireE("Agent", { subagent_type: "general-purpose", prompt: "ROLE: explore-search\nFind the callers." });
  check("E33", "END-TO-END: a launch with NO effort is BLOCKED, naming the required effort",
    noEffort.status === 2 && noEffort.reason.includes("EFFORT_MISSING") && noEffort.reason.includes("effort: medium"), `exit=${noEffort.status}`);
  const OV_REASON = "one-off: the receipt needs judgement this time";
  const overridden = fireE("Agent",
    { subagent_type: "general-purpose", prompt: `ROLE: mechanical-receipt\nEFFORT-OVERRIDE: high — ${OV_REASON}\nWrite it.`, effort: "high" },
    { agent_id: "aorch-0123456789abcdef", tool_use_id: "toolu-ov" });
  const useLedger = path.join(sbE.dir, ".claude", "learning", "override-receipt-uses.jsonl");
  let ovRows = [];
  try { ovRows = fs.readFileSync(useLedger, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { ovRows = []; }
  const reasonSha = crypto.createHash("sha256").update(OV_REASON, "utf8").digest("hex");
  check("E34", "END-TO-END: the override PASSES (exit 0) and says it was honoured",
    overridden.status === 0 && overridden.json?.continue === true && overridden.ctx.includes("OVERRIDE_HONOURED"),
    `exit=${overridden.status}`);
  check("E35", "END-TO-END: the honoured override is LOGGED — one use-ledger row with the reason HASH, the levels and the consumer",
    ovRows.length === 1 && ovRows[0].channel === "agents/effort-routing/EFFORT-OVERRIDE" &&
      ovRows[0].reason_sha256 === reasonSha && ovRows[0].detail?.required === "low" &&
      ovRows[0].detail?.applied === "high" && ovRows[0].detail?.role === "mechanical-receipt" &&
      ovRows[0].consumer?.tool_use_id === "toolu-ov" && !JSON.stringify(ovRows[0]).includes(OV_REASON),
    JSON.stringify(ovRows), "honour the override without recording it");

  // RE-TASKING through SendMessage: the launch effort comes from the T1 dispatch ledger.
  const DL = require(path.join(REPO, ".claude/hooks/lib/dispatch-ledger.js"));
  const seeded = DL.appendRecord({ repoDir: sbE.dir, record: Object.assign(
    DL.buildLaunchRecord({ sessionId: "s-effort", generation: DL.MAIN_GENERATION, dispatchName: "lane-r", subagentType: "general-purpose", nowIso: new Date().toISOString() }),
    { effort: "high", role: "security-review" }) });
  const reHigh = fireE("SendMessage", { to: "lane-r", message: "ROLE: mechanical-receipt\nNow write the receipt." });
  check("E36", "END-TO-END RE-TASK: a LOW role sent to a HIGH-launched agent is BLOCKED: dispatch a fresh agent at low",
    seeded.ok === true && reHigh.status === 2 && reHigh.reason.includes("dispatch a fresh agent at low"),
    `seeded=${seeded.ok} exit=${reHigh.status}`, "the guard ignores SendMessage");
  const reSame = fireE("SendMessage", { to: "lane-r", message: "ROLE: correctness-review\nNow check the tests." });
  check("E37", "END-TO-END RE-TASK CONTROL: a role of the SAME effort passes untouched",
    reSame.status === 0 && reSame.ctx === "", `exit=${reSame.status}`);
  const reUnknown = fireE("SendMessage", { to: "never-launched", message: "ROLE: mechanical-receipt\nx" });
  check("E38", "END-TO-END RE-TASK: an agent with no recorded launch effort is ADVISORY only (exit 0)",
    reUnknown.status === 0 && reUnknown.ctx.includes("RETASK_LAUNCH_UNKNOWN"), `exit=${reUnknown.status}`, "block on missing history");
  const rePlain = fireE("SendMessage", { to: "lane-r", message: "also check line 40" });
  check("E39", "END-TO-END RE-TASK: a follow-up with no ROLE line passes untouched",
    rePlain.status === 0 && rePlain.ctx === "", `exit=${rePlain.status}`);

  // The TABLE at the hook boundary: a COPY of the hook tree inside a sandbox, with its table broken.
  const sbT = makeHookSandbox("table");
  fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(sbT.dir, ".claude", "hooks"), { recursive: true });
  const tablePath = path.join(sbT.dir, ".claude", "hooks", "lib", "effort-routing-policy.json");
  const copyHook = path.join(sbT.dir, ".claude", "hooks", "dispatch-contract-guard.js");
  const fireT = () => {
    const r = spawnHook(sbT, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit.", effort: "high" } }), {}, { raw: true, hook: copyHook });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, reason: json?.hookSpecificOutput?.permissionDecisionReason || "" };
  };
  const copyOk = fireT();
  check("E40", "END-TO-END TABLE CONTROL: the copied hook tree with the INTACT table passes a correct launch",
    copyOk.status === 0, `exit=${copyOk.status}`);
  fs.writeFileSync(tablePath, JSON.stringify({ schema_version: 1, roles: { "security-review": "ultra" } }));
  const badValue = fireT();
  fs.writeFileSync(tablePath, JSON.stringify({ schema_version: 1, roles: { "security-review": "high" }, surprise: 1 }));
  const badKey = fireT();
  fs.rmSync(tablePath, { force: true });
  const noTable = fireT();
  check("E41", "END-TO-END TABLE: an unknown value, an unknown key, and an ABSENT table each BLOCK with `routing table invalid`",
    [badValue, badKey, noTable].every((x) => x.status === 2 && x.reason.includes("routing table invalid")),
    `exits=${[badValue, badKey, noTable].map((x) => x.status).join(",")}`, "fall back to a default table");
  // FAIL-CLOSED on the LIBRARY too: a launch the arm cannot evaluate is a launch it cannot route.
  fs.rmSync(path.join(sbT.dir, ".claude", "hooks", "lib", "effort-routing.js"), { force: true });
  const noLib = fireT();
  check("E43", "END-TO-END: an UNLOADABLE effort-routing library BLOCKS a launch (UNEVALUABLE), never passes it",
    noLib.status === 2 && noLib.reason.includes("UNEVALUABLE"), `exit=${noLib.status}`,
    "fail open when the routing library will not load");

  // HONOURED ⇔ RECORDED: an override whose ledger row cannot be written is NOT honoured.
  const sbU = makeHookSandbox("unrecorded");
  fs.mkdirSync(path.join(sbU.dir, ".claude", "learning", "override-receipt-uses.jsonl"), { recursive: true });
  const rU = spawnHook(sbU, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input:
    { subagent_type: "general-purpose", prompt: "ROLE: mechanical-receipt\nEFFORT-OVERRIDE: high — needs judgement\nWrite it.", effort: "high" } }), {}, { raw: true });
  let jU = null;
  try { jU = JSON.parse(rU.stdout); } catch {}
  const reasonU = jU?.hookSpecificOutput?.permissionDecisionReason || "";
  check("E42", "END-TO-END: an override that CANNOT be recorded is refused — BLOCK (OVERRIDE_UNRECORDED), never a silent pass",
    rU.status === 2 && reasonU.includes("OVERRIDE_UNRECORDED"), `exit=${rU.status}`,
    "honour the override without its ledger row");

  // ── R1 fix batch (2026-10-12) ─────────────────────────────────────────────────────────────
  // RE-TASK ORDERING (correctness F1): the launch is resolved FIRST. With a KNOWN launch a bad ROLE,
  // a malformed override or an invalid table BLOCKS; with an UNKNOWN launch each is ADVISORY; a
  // message to `main` is never a re-task. Both poles, library level.
  const UNKNOWN_L = { state: "unknown", reason: "no launch row" };
  const rt = (to, message, launchState, table = tableOk) => (has("decideRetask")
    ? ER.decideRetask({ to, message }, table, launchState) : null);
  const badTable = has("validateRoutingTable") ? ER.validateRoutingTable({ schema_version: 2, roles: {} }) : null;
  check("E44", "RE-TASK, KNOWN launch: an unknown role, a malformed override and an invalid table each BLOCK",
    JSON.stringify(codes(rt("lane-r", "ROLE: wizard\nx", KNOWN_HIGH))) === '["block:ROLE_UNKNOWN"]' &&
      JSON.stringify(codes(rt("lane-r", "ROLE: extraction\nEFFORT-OVERRIDE: low\nx", KNOWN_HIGH))) === '["block:OVERRIDE_MALFORMED"]' &&
      JSON.stringify(codes(rt("lane-r", "ROLE: extraction\nx", KNOWN_HIGH, badTable))) === '["block:TABLE_INVALID"]',
    JSON.stringify([codes(rt("lane-r", "ROLE: wizard\nx", KNOWN_HIGH)), codes(rt("lane-r", "ROLE: extraction\nx", KNOWN_HIGH, badTable))]),
    "M-RT-ADVISE-ALL: make every re-task finding advisory");
  check("E45", "RE-TASK, UNKNOWN launch: the same three are ADVISORY only, never a block",
    JSON.stringify(codes(rt("peer", "ROLE: wizard\nx", UNKNOWN_L))) === '["advisory:ROLE_UNKNOWN"]' &&
      JSON.stringify(codes(rt("peer", "ROLE: extraction\nEFFORT-OVERRIDE: low\nx", UNKNOWN_L))) === '["advisory:OVERRIDE_MALFORMED"]' &&
      JSON.stringify(codes(rt("peer", "ROLE: extraction\nx", UNKNOWN_L, badTable))) === '["advisory:TABLE_INVALID"]',
    JSON.stringify([codes(rt("peer", "ROLE: wizard\nx", UNKNOWN_L)), codes(rt("peer", "ROLE: extraction\nx", UNKNOWN_L, badTable))]),
    "M-RT-ORDER: restore the role/override/table blocks BEFORE the launch-known check");
  check("E46", "RE-TASK: a message to `main` is never a re-task — no finding, whatever its ROLE line says",
    JSON.stringify(codes(rt("main", "ROLE: security-reviewer\nSECURITY: CLEAN", UNKNOWN_L))) === "[]" &&
      JSON.stringify(codes(rt("main", "ROLE: security-review\nreport", UNKNOWN_L))) === "[]",
    JSON.stringify(codes(rt("main", "ROLE: security-reviewer\nx", UNKNOWN_L))), "M-RT-MAIN: drop the lead-recipient skip");

  // ONE CODE FOR ONE INPUT (correctness F8): a present-but-unparseable ROLE line is ROLE_MALFORMED on
  // BOTH paths; an absent one stays ROLE_MISSING.
  check("E47", "ROLE_MALFORMED on BOTH paths for `ROLE: x (high)`; ROLE_MISSING stays for no ROLE line",
    JSON.stringify(codes(launch("ROLE: security-review (high)\nx", "high"))) === '["block:ROLE_MALFORMED"]' &&
      JSON.stringify(codes(rt("lane-r", "ROLE: security-review (high)\nx", KNOWN_HIGH))) === '["block:ROLE_MALFORMED"]' &&
      JSON.stringify(codes(launch("no role here", "high"))) === '["block:ROLE_MISSING"]',
    JSON.stringify([codes(launch("ROLE: security-review (high)\nx", "high")), codes(rt("lane-r", "ROLE: security-review (high)\nx", KNOWN_HIGH))]),
    "M-RT-CODE: hardcode ROLE_UNKNOWN on the re-task path");

  // FORK (security F1): a fork runs at its parent's effort, so it cannot satisfy the gate by
  // declaring one; it passes only under a recorded override.
  const forkLaunch = (prompt, effort) => (has("decideLaunch")
    ? ER.decideLaunch({ subagent_type: "fork", prompt, ...(effort === undefined ? {} : { effort }) }, tableOk) : null);
  check("E48", "FORK: a fork carrying the routed effort is BLOCKED (EFFORT_INAPPLICABLE); a fork with an override is honoured",
    JSON.stringify(codes(forkLaunch("ROLE: security-review\nx", "high"))) === '["block:EFFORT_INAPPLICABLE"]' &&
      JSON.stringify(codes(forkLaunch("ROLE: security-review\nEFFORT-OVERRIDE: medium — parent runs at medium\nx"))) === '["advisory:OVERRIDE_HONOURED"]' &&
      forkLaunch("ROLE: security-review\nEFFORT-OVERRIDE: medium — parent runs at medium\nx").override?.fork === true &&
      JSON.stringify(codes(launch("ROLE: security-review\nx", "high"))) === "[]",
    JSON.stringify(codes(forkLaunch("ROLE: security-review\nx", "high"))), "M-FORK: drop the fork branch");

  // ESCAPED DUPLICATE KEY (security F4): a key spelled with a JSON escape is refused.
  const escRaw = '{"schema_version":1,"roles":{"security-review":"high","\\u0073ecurity-review":"medium"}}';
  const escRes = has("validateRoutingTable") ? ER.validateRoutingTable(JSON.parse(escRaw), escRaw) : null;
  const docRaw = '{"schema_version":1,"_doc":["a \\"quoted\\" word"],"roles":{"security-review":"high"}}';
  const docRes = has("validateRoutingTable") ? ER.validateRoutingTable(JSON.parse(docRaw), docRaw) : null;
  check("E49", "TABLE: an escape-spelled duplicate key is INVALID; an escape inside a _doc VALUE is not",
    escRes?.ok === false && /JSON escape/.test(escRes.reason) && docRes?.ok === true,
    JSON.stringify({ escRes, docRes }), "M-ESC: drop the escaped-key refusal");

  // LEDGER PREFERENCE (security F7): a blocked launch and its corrected retry resolve to the retry.
  const rrow = (effort, routed) => ({ kind: "launch", launch_id: `lb-${effort}-${routed}`, dispatch_name: "lane-b", generation: "(main-agent)", effort, ...(routed === undefined ? {} : { effort_routed: routed }) });
  check("E50", "LEDGER: rows tagged effort_routed:true are preferred — a blocked launch + corrected retry is KNOWN",
    JSON.stringify(lf([rrow("medium", false), rrow("high", true)], "lane-b", "(main-agent)")) === JSON.stringify({ state: "known", effort: "high" }) &&
      lf([rrow("medium", undefined), rrow("high", undefined)], "lane-b", "(main-agent)").state === "unknown",
    JSON.stringify(lf([rrow("medium", false), rrow("high", true)], "lane-b", "(main-agent)")), "M-ROUTED: read every row");
  let EDL = null;
  try { EDL = require(path.join(REPO, ".claude/hooks/emit-dispatch-ledger.js")); } catch { EDL = null; }
  const dOk = EDL ? EDL.declaredEffortOf({ subagent_type: "general-purpose", prompt: "ROLE: security-review\nx", effort: "high" }) : null;
  const dBad = EDL ? EDL.declaredEffortOf({ subagent_type: "general-purpose", prompt: "ROLE: security-review\nx", effort: "low" }) : null;
  const dFork = EDL ? EDL.declaredEffortOf({ subagent_type: "fork", prompt: "ROLE: security-review\nx", effort: "high" }) : null;
  check("E51", "LEDGER PRODUCER: tags the routing verdict, and records a fork's effort as null",
    dOk?.effortRouted === true && dOk?.effort === "high" && dBad?.effortRouted === false && dFork?.effort === null,
    JSON.stringify({ dOk, dBad, dFork }), "M-FORKNULL: record the fork's declared effort");

  // END-TO-END re-task poles through the RE-TASK ENTRY (lane-r is seeded HIGH above).
  const toMain = fireE("SendMessage", { to: "main", message: "ROLE: security-reviewer\nSECURITY: CLEAN" });
  const toPeer = fireE("SendMessage", { to: "peer-x", message: "ROLE: wizard\nreport" });
  const toKnownBad = fireE("SendMessage", { to: "lane-r", message: "ROLE: wizard\nNow do it." });
  check("E52", "END-TO-END RE-TASK: an unknown ROLE to `main` passes untouched, to an unlaunched peer is advisory, to a KNOWN launch blocks",
    toMain.status === 0 && toMain.ctx === "" &&
      toPeer.status === 0 && toPeer.ctx.includes("ROLE_UNKNOWN") && toPeer.ctx.includes("follow-up") &&
      toKnownBad.status === 2 && toKnownBad.reason.includes("ROLE_UNKNOWN"),
    `main=${toMain.status} peer=${toPeer.status} known=${toKnownBad.status}`, "M-RT-ORDER / M-RT-MAIN");
  const advCtx = toPeer.ctx;
  check("E53", "NON-BLOCK RENDER for effort advisories: says follow-up, explains the effort tier, not the prose-cap rationale",
    advCtx.includes("This SendMessage follow-up has NOT been issued yet") && advCtx.includes("launch effort is UNKNOWN") &&
      !advCtx.includes("agent-definition-shadowing"),
    advCtx.slice(0, 160), "M-RENDER: restore the dispatch-contract-only rationale");
  // Each entry acts ONLY on its own tools: the launch entry passes a SendMessage, the re-task entry
  // passes a launch — so the two registrations never judge one call twice.
  const launchEntryOnSend = fireE("SendMessage", { to: "lane-r", message: "ROLE: mechanical-receipt\nx" }, {}, {}, { hook: HOOK });
  const retaskEntryOnLaunch = fireE("Agent", { subagent_type: "general-purpose", prompt: "no role" }, {}, {}, { hook: RETASK_HOOK });
  check("E54", "SCOPE: the launch entry ignores SendMessage and the re-task entry ignores a launch (each exit 0, no context)",
    launchEntryOnSend.status === 0 && launchEntryOnSend.ctx === "" && retaskEntryOnLaunch.status === 0 && retaskEntryOnLaunch.ctx === "",
    `launch-on-send=${launchEntryOnSend.status} retask-on-launch=${retaskEntryOnLaunch.status}`, "M-SCOPE: accept both tool sets in both entries");

  // REGISTRATION (correctness F2): the re-task entry is its own SendMessage row declaring continue;
  // the launch entry keeps Task|Agent at deny. Read from the registry the dispatcher reads.
  const regJ = JSON.parse(fs.readFileSync(path.join(REPO, ".claude/hooks/dispatch-registry.json"), "utf8"));
  const rowsOf = (base) => regJ.events.PreToolUse.groups.flatMap((g) => g.hooks.filter((h) => h.command.includes(`/${base}`)).map((h) => ({ matcher: g.matcher, on: h.on_incomplete })));
  check("E55", "REGISTRY: dispatch-retask-guard.js = SendMessage/continue; dispatch-contract-guard.js = Task|Agent|Workflow/deny only",
    JSON.stringify(rowsOf("dispatch-retask-guard.js")) === JSON.stringify([{ matcher: "SendMessage", on: "continue" }]) &&
      JSON.stringify(rowsOf("dispatch-contract-guard.js")) === JSON.stringify([{ matcher: "Task|Agent|Workflow", on: "deny" }]),
    JSON.stringify({ retask: rowsOf("dispatch-retask-guard.js"), contract: rowsOf("dispatch-contract-guard.js") }));

  // FORK END-TO-END + its ledger row (security F1).
  const forkBlocked = fireE("Agent", { subagent_type: "fork", prompt: "ROLE: security-review\nAudit.", effort: "high" });
  const forkOv = fireE("Agent", { subagent_type: "fork", prompt: "ROLE: security-review\nEFFORT-OVERRIDE: medium — parent session runs at medium\nAudit.", effort: "high" }, { tool_use_id: "toolu-fork" });
  let fRows = [];
  try { fRows = fs.readFileSync(useLedger, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { fRows = []; }
  const forkRow = fRows.find((r) => r.consumer?.tool_use_id === "toolu-fork");
  check("E56", "END-TO-END FORK: blocked without an override; with one it passes and the ledger row says the PARENT's effort applied",
    forkBlocked.status === 2 && forkBlocked.reason.includes("EFFORT_INAPPLICABLE") &&
      forkOv.status === 0 && forkRow?.detail?.applied === "parent (fork)" && forkRow?.detail?.declared === "medium",
    `blocked=${forkBlocked.status} ov=${forkOv.status} row=${JSON.stringify(forkRow?.detail)}`, "M-FORK");

  // ENV CHANNEL (security F2): the session-wide env lift does NOT lift an effort block, and says so.
  const envMism = fireE("Agent", { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit.", effort: "low" }, {}, { [L.OVERRIDE_ENV]: "1" });
  check("E57", "END-TO-END ENV: COC_ALLOW_DISPATCH_CONTRACT=1 does NOT lift an effort block, and the block says only a recorded override can",
    envMism.status === 2 && envMism.reason.includes("EFFORT_MISMATCH") &&
      (envMism.reason + envMism.stderr).includes("environment channel does NOT lift"),
    `exit=${envMism.status}`, "M-ENV: consult process.env for effort blocks again");

  // RECEIPT DIGEST BINDS EFFORT (security F6): a receipt for the brief at effort "low" does not lift
  // it at "medium", and does lift it at "low", recording the applied effort on the receipt row.
  const RB_PROMPT = "ROLE: security-review\nAudit the receipt-binding case.";
  const rbPayload = (effort) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: RB_PROMPT, effort } });
  const rbDigestLow = documentedDigest(rbPayload("low"), ["agents/effort-routing@low"]);
  fs.mkdirSync(path.dirname(sbE.receipt), { recursive: true });
  fs.writeFileSync(sbE.receipt, receiptLine(rbDigestLow, "approved at low for this one audit") + "\n");
  const rbMedium = fireE("Agent", rbPayload("medium").tool_input);
  const rbStillThere = fs.existsSync(sbE.receipt);
  const rbLow = fireE("Agent", rbPayload("low").tool_input, { tool_use_id: "toolu-rb" });
  let rbRows = [];
  try { rbRows = fs.readFileSync(useLedger, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { rbRows = []; }
  const rbRow = rbRows.find((r) => r.consumer?.tool_use_id === "toolu-rb");
  check("E58", "END-TO-END RECEIPT: a receipt bound at effort low does not lift effort medium, lifts low, and records applied=low",
    rbMedium.status === 2 && rbStillThere && rbLow.status === 0 && !fs.existsSync(sbE.receipt) &&
      rbRow?.detail?.applied === "low" && rbRow?.channel === ".claude/dispatch-authz/dispatch-contract-allow",
    `medium=${rbMedium.status} kept=${rbStillThere} low=${rbLow.status} row=${JSON.stringify(rbRow?.detail)}`,
    "M-DIGEST-EFFORT: bind effort findings by the bare rule id");
  try { fs.rmSync(sbE.receipt, { force: true }); } catch {}

  // MISSING SIBLING LIBRARIES (security F3): an effort block still BLOCKS with any of the guard's
  // other libraries gone; a copied hook tree per library, mismatch launch each time.
  const sbL = makeHookSandbox("libs");
  const libsFire = (removed) => {
    const root = path.join(sbL.dir, `tree-${removed.replace(/\W/g, "_")}`);
    fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(root, ".claude", "hooks"), { recursive: true });
    fs.rmSync(path.join(root, ".claude", "hooks", "lib", removed), { force: true });
    const r = spawnHook(sbL, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit.", effort: "medium" } }), {}, { raw: true, hook: path.join(root, ".claude", "hooks", "dispatch-contract-guard.js") });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, reason: json?.hookSpecificOutput?.permissionDecisionReason || "", decision: json?.hookSpecificOutput?.permissionDecision };
  };
  const noContract = libsFire("dispatch-contract.js");
  const noOverride = libsFire("override-receipt.js");
  const noRenderer = libsFire("instruct-and-wait.js");
  check("E59", "FAIL-CLOSED: with lib/dispatch-contract.js, lib/override-receipt.js or lib/instruct-and-wait.js gone, an effort mismatch still BLOCKS (deny, EFFORT_MISMATCH)",
    [noContract, noOverride, noRenderer].every((x) => x.status === 2 && x.decision === "deny" && x.reason.includes("EFFORT_MISMATCH")),
    `exits=${[noContract, noOverride, noRenderer].map((x) => x.status).join(",")}`, "M-LIBS: return passthrough when a sibling library will not load");

  // SYMLINKED TABLE (security F5): a table that is a symlink is never followed.
  const sbS = makeHookSandbox("symlink");
  fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(sbS.dir, ".claude", "hooks"), { recursive: true });
  const sTable = path.join(sbS.dir, ".claude", "hooks", "lib", "effort-routing-policy.json");
  const permissive = path.join(sbS.dir, "permissive-table.json");
  fs.writeFileSync(permissive, JSON.stringify({ schema_version: 1, roles: { "security-review": "medium" } }));
  fs.rmSync(sTable, { force: true });
  fs.symlinkSync(permissive, sTable);
  const sRes = has("loadRoutingTable") ? ER.loadRoutingTable(sTable) : null;
  const sReal = has("loadRoutingTable") ? ER.loadRoutingTable(permissive) : null;
  check("E60", "TABLE: a symlinked table is INVALID (never followed), while the file it points at loads VALID",
    sRes?.ok === false && /symlink/.test(sRes.reason) && sReal?.ok === true,
    JSON.stringify({ sRes, sReal: sReal?.ok }), "M-SYMLINK: read the table with statSync/readFileSync again");

  // ── SELF-CORRECTION (owner ruling on correctness #4, 2026-10-12: "a block that main agents can see
  // and correct … not a block that requires human intervention"). Every effort-routing block names
  // the exact corrected first line, every valid role from the SHIPPED table, the required effort and
  // how to pass it on both runtimes, and the roles a generic launch can pick — and a relaunch built
  // from ONLY the deny text is ALLOWED, through the real guard, on Claude AND on the Codex projection.
  const shippedRoles = Object.entries(JSON.parse(fs.readFileSync(path.join(REPO, ".claude/hooks/lib/effort-routing-policy.json"), "utf8")).roles);
  const namesEveryRole = (t) => shippedRoles.every(([r, l]) => t.includes(`${r} (${l})`));
  const namesBothParams = (t) => t.includes("`effort") && t.includes("`reasoning_effort");
  const namesGeneric = (t) => t.includes("A generic launch") && t.includes("`ROLE: explore-search`") && t.includes("`ROLE: routine-implementation`");
  const selfCorrect = (t) => t.includes("SELF-CORRECT (no human step needed)") && namesEveryRole(t) && namesBothParams(t) && namesGeneric(t);
  /** The corrected `{line, effort}` a deny text names for a KNOWN role, or the generic pick for an unknown one. */
  const correctionOf = (t) => {
    const m = String(t).match(/FIRST line exactly `(ROLE: [a-z0-9-]+)` and pass effort ([a-z]+) /);
    if (m) return { line: m[1], effort: m[2] };
    const g = String(t).match(/A generic launch[^`]*`(ROLE: [a-z0-9-]+)` \(effort ([a-z]+)\)/);
    return g ? { line: g[1], effort: g[2] } : null;
  };
  const libBlocks = has("decideLaunch") && has("decideRetask") ? [
    ["ROLE_MISSING", ER.decideLaunch({ prompt: "Audit.", effort: "high" }, tableOk), null],
    ["ROLE_MALFORMED", ER.decideLaunch({ prompt: "ROLE: security-review (high)\nAudit.", effort: "high" }, tableOk), null],
    ["ROLE_UNKNOWN", ER.decideLaunch({ prompt: "ROLE: wizard\nx", effort: "high" }, tableOk), null],
    ["OVERRIDE_MALFORMED", ER.decideLaunch({ prompt: "ROLE: extraction\nEFFORT-OVERRIDE: low\nx", effort: "low" }, tableOk), ["ROLE: extraction", "low"]],
    ["EFFORT_MISSING", ER.decideLaunch({ prompt: "ROLE: extraction\nx" }, tableOk), ["ROLE: extraction", "low"]],
    ["EFFORT_MISMATCH", ER.decideLaunch({ prompt: "ROLE: extraction\nx", effort: "high" }, tableOk), ["ROLE: extraction", "low"]],
    ["EFFORT_MISMATCH(override)", ER.decideLaunch({ prompt: "ROLE: extraction\nEFFORT-OVERRIDE: high — r\nx", effort: "medium" }, tableOk), ["ROLE: extraction", "low"]],
    ["EFFORT_INAPPLICABLE", ER.decideLaunch({ subagent_type: "fork", prompt: "ROLE: security-review\nx", effort: "high" }, tableOk), ["ROLE: security-review", "high"]],
    ["RETASK ROLE_MISSING-shape", ER.decideRetask({ to: "lane-r", message: "ROLE:\nx" }, tableOk, KNOWN_HIGH), null],
    ["RETASK ROLE_UNKNOWN", ER.decideRetask({ to: "lane-r", message: "ROLE: wizard\nx" }, tableOk, KNOWN_HIGH), null],
    ["RETASK OVERRIDE_MALFORMED", ER.decideRetask({ to: "lane-r", message: "ROLE: extraction\nEFFORT-OVERRIDE: low\nx" }, tableOk, KNOWN_HIGH), ["ROLE: extraction", "low"]],
    ["RETASK_EFFORT_MISMATCH", ER.decideRetask({ to: "lane-r", message: "ROLE: mechanical-receipt\nx" }, tableOk, KNOWN_HIGH), ["ROLE: mechanical-receipt", "low"]],
  ] : [];
  const libBad = libBlocks.filter(([, r, want]) => {
    const f = r?.findings?.[0];
    if (!f || f.severity !== "block" || !selfCorrect(f.evidence)) return true;
    if (!want) return false;
    const c = correctionOf(f.evidence);
    return !(c && c.line === want[0] && c.effort === want[1]);
  }).map(([n]) => n);
  check("E61", "SELF-CORRECT: every effort block (launch + re-task) names the corrected `ROLE:` line + effort, every shipped role, both effort params, and the generic roles",
    libBlocks.length === 12 && libBad.length === 0, `bad=${JSON.stringify(libBad)} n=${libBlocks.length}`,
    "M-REMEDY-ROLES / M-REMEDY-GENERIC / M-REMEDY-LINE / M-REMEDY-CODEX");

  // F9 — no deny path needs a human: an INVALID table and an unloadable library each name the
  // restore the agent can run itself, and the library-less remedy still lists the shipped roles.
  const invEv = has("decideLaunch") ? ER.decideLaunch({ prompt: "ROLE: a\nx", effort: "high" }, invalidTable).findings[0].evidence : "";
  const sbUv = makeHookSandbox("uneval");
  const uRoot = path.join(sbUv.dir, "tree");
  fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(uRoot, ".claude", "hooks"), { recursive: true });
  const uLib = path.join(uRoot, ".claude", "hooks", "lib", "effort-routing.js");
  const uHook = path.join(uRoot, ".claude", "hooks", "dispatch-contract-guard.js");
  const uFire = (ti) => {
    const r = spawnHook(sbUv, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", session_id: "s-uneval", tool_input: ti }), {}, { raw: true, hook: uHook });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, reason: json?.hookSpecificOutput?.permissionDecisionReason || "" };
  };
  const uBytes = fs.readFileSync(uLib);
  fs.rmSync(uLib, { force: true });
  const uDenied = uFire({ subagent_type: "general-purpose", prompt: "Audit.", effort: "high" });
  // The agent's own remedy: restore the shipped library, then relaunch with a line the deny text named.
  fs.writeFileSync(uLib, uBytes);
  const uLine = (uDenied.reason.match(/`(ROLE: explore-search)` \(effort ([a-z]+)\)/) || []);
  const uRelaunch = uLine[1] ? uFire({ subagent_type: "general-purpose", prompt: `${uLine[1]}\nFind the callers.`, effort: uLine[2] }) : { status: -1 };
  check("E62", "NO HUMAN EXIT NEEDED: TABLE_INVALID and UNEVALUABLE each name the self-run restore; the library-less deny still lists every shipped role, and restore + relaunch from it is ALLOWED",
    invEv.includes("SELF-CORRECT (no human step needed)") && invEv.includes("git checkout HEAD -- .claude/hooks/lib/effort-routing-policy.json") &&
      uDenied.status === 2 && uDenied.reason.includes("UNEVALUABLE") &&
      uDenied.reason.includes("git checkout HEAD -- .claude/hooks/lib/effort-routing.js") &&
      shippedRoles.every(([r, l]) => uDenied.reason.includes(`\`ROLE: ${r}\` (effort ${l})`)) && uRelaunch.status === 0,
    `uneval=${uDenied.status} relaunch=${uRelaunch.status}`, "M-TABLE-RESTORE / M-UNEVAL-ROLES");

  // END-TO-END on CLAUDE: a mismatched launch and a role-less launch, each relaunched with EXACTLY the
  // corrected line and effort parsed out of its own deny text, and nothing else changed.
  const BODY = "Find every caller of the routing table.";
  const c1 = fireE("Agent", { subagent_type: "general-purpose", prompt: `ROLE: bounded-bugfix\n${BODY}`, effort: "low" });
  const k1 = correctionOf(c1.reason);
  const r1 = k1 ? fireE("Agent", { subagent_type: "general-purpose", prompt: `${k1.line}\n${BODY}`, effort: k1.effort }) : { status: -1, ctx: "x" };
  const c2 = fireE("Agent", { subagent_type: "Explore", prompt: BODY, effort: "high" });
  const k2 = correctionOf(c2.reason);
  const r2 = k2 ? fireE("Agent", { subagent_type: "Explore", prompt: `${k2.line}\n${BODY}`, effort: k2.effort }) : { status: -1, ctx: "x" };
  check("E63", "END-TO-END CLAUDE: relaunching with exactly the corrected line + effort named in the deny is ALLOWED (mismatch, and a generic role-less Explore launch)",
    c1.status === 2 && selfCorrect(c1.reason) && k1?.line === "ROLE: bounded-bugfix" && k1?.effort === "medium" && r1.status === 0 && r1.ctx === "" &&
      c2.status === 2 && selfCorrect(c2.reason) && k2?.line === "ROLE: explore-search" && r2.status === 0 && r2.ctx === "",
    `deny1=${c1.status} relaunch1=${r1.status} deny2=${c2.status} relaunch2=${r2.status} k2=${JSON.stringify(k2)}`,
    "M-REMEDY-LINE / M-REMEDY-GENERIC");

  // END-TO-END on CODEX: a NATIVE spawn_agent payload (`message`, `agent_type`, `reasoning_effort`)
  // projected by the real adapter projection (`lib/codex-native-policy.js::projectPayloads`, which
  // normalizes `reasoning_effort` -> `effort`), fired at the real guard; the deny names the Codex
  // parameter, and a native relaunch built from it is ALLOWED. This drives the projection + guard,
  // not a whole `--native-policy` run (that writes adapter state into the checkout).
  let CNP = null;
  try { CNP = require(path.join(REPO, ".claude/hooks/lib/codex-native-policy.js")); } catch { CNP = null; }
  const fireCodex = (input) => {
    if (!CNP) return { status: -1, reason: "", ctx: "x" };
    const [proj] = CNP.projectPayloads({ hook_event_name: "PreToolUse", tool_name: "spawn_agent", session_id: "s-effort", tool_input: input });
    return fireE(proj.tool_name, proj.tool_input);
  };
  const x1 = fireCodex({ agent_type: "worker", message: `ROLE: security-review\n${BODY}`, reasoning_effort: "low" });
  const kx = correctionOf(x1.reason);
  const xr = kx ? fireCodex({ agent_type: "worker", message: `${kx.line}\n${BODY}`, reasoning_effort: kx.effort }) : { status: -1, ctx: "x" };
  check("E64", "END-TO-END CODEX: a native spawn_agent deny names `reasoning_effort`, and a native relaunch with exactly the corrected line + effort is ALLOWED",
    x1.status === 2 && x1.reason.includes(`reasoning_effort: "high"`) && kx?.line === "ROLE: security-review" && kx?.effort === "high" &&
      xr.status === 0 && xr.ctx === "",
    `deny=${x1.status} relaunch=${xr.status} k=${JSON.stringify(kx)}`, "M-REMEDY-CODEX / M-REMEDY-LINE");

  // RE-TASK END-TO-END: the re-task deny names the fresh launch, and that launch is ALLOWED.
  const rtD = fireE("SendMessage", { to: "lane-r", message: "ROLE: mechanical-receipt\nWrite the receipt." });
  const kr = correctionOf(rtD.reason);
  const rtFresh = kr ? fireE("Agent", { subagent_type: "general-purpose", prompt: `${kr.line}\nWrite the receipt.`, effort: kr.effort }) : { status: -1, ctx: "x" };
  check("E65", "END-TO-END RE-TASK: the deny names a FRESH launch's corrected line + effort, and that launch is ALLOWED",
    rtD.status === 2 && rtD.reason.includes("RETASK_EFFORT_MISMATCH") && rtD.reason.includes("FRESH (non-fork)") &&
      kr?.line === "ROLE: mechanical-receipt" && kr?.effort === "low" && rtFresh.status === 0 && rtFresh.ctx === "",
    `deny=${rtD.status} fresh=${rtFresh.status}`, "M-REMEDY-LINE");

  // ── ROOT-W1 (2026-10-12): a Workflow script's agent() launches fire no PreToolUse Task|Agent, so the
  // launch entry judges the Workflow call itself — each literal agent() call exactly as a launch.
  let WS = null;
  try { WS = require(path.join(REPO, ".claude/hooks/lib/workflow-launch-scan.js")); } catch { WS = null; }
  const WF_SCRIPT = [
    "export const meta = { name: 'probe', description: 'probe' }",
    "// agent('commented out', {effort: 'low'})",
    "const re = /agent\\(/g; const half = n / 2;",
    "const a = await agent('ROLE: explore-search\\nFind it', {effort: 'medium', schema: S})",
    "const b = await agent(`ROLE: security-review\\nAudit ${f}`, {effort: \"high\"})",
    "const c = await parallel(xs.map(x => () => agent(x.prompt, {effort: 'high'})))",
    "const d = await agent('ROLE: extraction\\nx', {...base})",
    "tool.agent('a member named agent — not provably the hook, so it is reported')",
    "await workflow('child', {})",
    "const e = await agent(`ROLE: extraction\\nEFFORT-OVERRIDE: high — needs the deep pass\\n${body}`, {effort: 'high'})",
  ].join("\n");
  const wscan = WS ? WS.scanWorkflowScript(WF_SCRIPT) : null;
  const wsum = wscan && wscan.ok ? wscan.calls.map((c) => [c.line, c.prompt.evaluable, c.options.evaluable, c.options.effort]) : null;
  check("E66", "WORKFLOW SCANNER: finds each direct agent() call with its line, reads literal prompts/efforts, flags non-literal ones, skips comments and regex literals, reports a member named `agent` as INDIRECT, counts nested workflow()",
    JSON.stringify(wsum) === JSON.stringify([[4, true, true, "medium"], [5, true, true, "high"], [6, false, true, "high"], [7, true, false, null], [10, true, true, "high"]]) &&
      wscan.nested.length === 1 && wscan.nested[0].line === 9 && wscan.calls[1].prompt.text === "ROLE: security-review\n" &&
      wscan.calls[4].prompt.overrideUnknown === false && wscan.calls[4].prompt.text.includes("EFFORT-OVERRIDE: high") &&
      wscan.indirect.length === 1 && wscan.indirect[0].line === 8 && wscan.indirect[0].why.includes("member name"),
    JSON.stringify({ wsum, nested: wscan && wscan.nested, indirect: wscan && wscan.indirect }), "M-WFP-OCCURRENCE / M-WS-TPL");

  const fireW = (tool_input, extra = {}) => fireE("Workflow", tool_input, extra);
  const wfOf = (...calls) => ["export const meta = { name: 'w', description: 'w' }", ...calls].join("\n");
  const wPass = fireW({ script: wfOf("await agent('ROLE: explore-search\\nFind the callers.', {effort: 'medium'})") });
  check("E67", "END-TO-END WORKFLOW: a script whose literal agent() calls are routed correctly passes UNTOUCHED (exit 0, no context)",
    wPass.status === 0 && wPass.ctx === "" && wPass.reason === "", `exit=${wPass.status} ctx=${wPass.ctx.slice(0, 120)}`, "M-WF-ALWAYS-BLOCK");
  const wNoRole = fireW({ script: wfOf("const x = 1", "await agent('Find the callers.', {effort: 'medium'})") });
  const kw = correctionOf(wNoRole.reason);
  const wFixed = kw ? fireW({ script: wfOf("const x = 1", `await agent('${kw.line}\\nFind the callers.', {effort: '${kw.effort}'})`) }) : { status: -1, ctx: "x" };
  check("E68", "END-TO-END WORKFLOW: a literal agent() prompt with no ROLE line BLOCKS the Workflow, naming its script line and the self-correction; the script rewritten from the deny passes",
    wNoRole.status === 2 && wNoRole.reason.includes("ROLE_MISSING") && wNoRole.reason.includes("script line 3") &&
      selfCorrect(wNoRole.reason) && wNoRole.reason.includes("agent(prompt, {effort") && wFixed.status === 0 && wFixed.ctx === "",
    `deny=${wNoRole.status} fixed=${wFixed.status} k=${JSON.stringify(kw)}`, "M-WF-SKIP / M-WF-LINE");
  const wWrong = fireW({ script: wfOf("await agent('ROLE: security-review\\nAudit.', {effort: 'low'})") });
  const wNone = fireW({ script: wfOf("await agent('ROLE: security-review\\nAudit.')") });
  const kww = correctionOf(wWrong.reason);
  check("E69", "END-TO-END WORKFLOW: a literal effort that differs from the table BLOCKS (EFFORT_MISMATCH, effort high), and an agent() with no effort option BLOCKS (EFFORT_MISSING)",
    wWrong.status === 2 && wWrong.reason.includes("EFFORT_MISMATCH") && kww?.line === "ROLE: security-review" && kww?.effort === "high" &&
      wNone.status === 2 && wNone.reason.includes("EFFORT_MISSING"),
    `wrong=${wWrong.status} none=${wNone.status}`, "M-WF-EFFORT");
  // FAIL-CLOSED (root ruling 2026-10-12, overriding the first ROOT-W1 wording): an agent() whose ROLE or
  // effort cannot be read literally DENIES, with the make-it-literal remedy, the role list and — where the
  // role is known — the required effort; a script rewritten literally from the deny passes.
  const wNonLit = fireW({ script: wfOf(
    "await agent(task.prompt, {effort: 'high'})",
    "await agent('ROLE: extraction\\nx', {...opts})",
    "await workflow('child')",
    "await agent(`ROLE: extraction\\n${body}`, {effort: 'high'})") });
  const wLitFixed = fireW({ script: wfOf(
    "await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})",
    "await agent('ROLE: extraction\\nx', {effort: 'low'})",
    "await agent(`ROLE: extraction\\n${body}`, {effort: 'low'})") });
  check("E70", "END-TO-END WORKFLOW FAIL-CLOSED: a non-literal prompt, a non-literal effort, a nested workflow() and a hidden-override mismatch each DENY with the make-it-literal remedy; the literal rewrite passes",
    wNonLit.status === 2 && (wNonLit.reason.match(/WORKFLOW_UNEVALUATED/g) || []).length === 2 &&
      wNonLit.reason.includes("WORKFLOW_NESTED_UNRESOLVED") && wNonLit.reason.includes("script line 5: EFFORT_MISMATCH") &&
      wNonLit.reason.includes("script line 2") && wNonLit.reason.includes("script line 3") &&
      wNonLit.reason.includes("make the ROLE line and the effort literal in this agent() call") &&
      wNonLit.reason.includes("Role `extraction` requires effort: low") && namesEveryRole(wNonLit.reason) &&
      wLitFixed.status === 0 && wLitFixed.ctx === "",
    `exit=${wNonLit.status} fixed=${wLitFixed.status} reason=${wNonLit.reason.slice(0, 160)}`,
    "M-WF-NONLIT-ADVISORY / M-WF-NESTED-ADVISORY / M-WF-HIDDEN-SOFT");
  // Each construct ALONE: in E70's combined script any one of them softened to advisory is still denied by
  // the other three, so only a one-construct script shows that construct itself fails closed.
  const wAlone = {
    prompt: fireW({ script: wfOf("await agent(task.prompt, {effort: 'high'})") }),
    options: fireW({ script: wfOf("await agent('ROLE: extraction\\nx', {...opts})") }),
    nested: fireW({ script: wfOf("await workflow('child')") }),
    hidden: fireW({ script: wfOf("await agent(`ROLE: extraction\\n${body}`, {effort: 'high'})") }),
  };
  check("E70a", "END-TO-END WORKFLOW FAIL-CLOSED, ONE CONSTRUCT PER SCRIPT: a non-literal prompt, a non-literal effort, a nested workflow() and a hidden-override mismatch EACH deny on their own",
    wAlone.prompt.status === 2 && wAlone.prompt.reason.includes("WORKFLOW_UNEVALUATED") &&
      wAlone.options.status === 2 && wAlone.options.reason.includes("WORKFLOW_UNEVALUATED") &&
      wAlone.options.reason.includes("Role `extraction` requires effort: low") &&
      [wAlone.prompt, wAlone.options].every((r) => r.reason.includes("make the ROLE line and the effort literal")) &&
      wAlone.nested.status === 2 && wAlone.nested.reason.includes("WORKFLOW_NESTED_UNRESOLVED") &&
      wAlone.nested.reason.includes("inline the child's agent() calls") &&
      wAlone.hidden.status === 2 && wAlone.hidden.reason.includes("EFFORT_MISMATCH") &&
      wAlone.hidden.reason.includes("write the override line literally") &&
      Object.values(wAlone).every((r) => selfCorrect(r.reason) && namesEveryRole(r.reason)),
    Object.entries(wAlone).map(([k, r]) => `${k}=${r.status}`).join(" "),
    "M-WF-NONLIT-ADVISORY / M-WF-OPTS-ADVISORY / M-WF-NESTED-ADVISORY / M-WF-HIDDEN-SOFT");
  const wName = fireW({ name: "no-such-saved-workflow" });
  const wsTarget = path.join(sbE.dir, "real-script.js");
  fs.writeFileSync(wsTarget, wfOf("await agent('no role', {effort: 'low'})"));
  const wsLink = path.join(sbE.dir, "linked-script.js");
  fs.symlinkSync(wsTarget, wsLink);
  const wLink = fireW({ scriptPath: wsLink });
  const wPath = fireW({ scriptPath: wsTarget });
  const wUnscannable = fireW({ script: wfOf("await agent('ROLE: explore-search\\nunterminated, {effort: 'medium'})") });
  check("E71", "END-TO-END WORKFLOW FAIL-CLOSED: an unresolvable saved name, a symlinked scriptPath and an unscannable script DENY (WORKFLOW_UNRESOLVED, the link never followed) with the inline-the-script remedy; the real scriptPath IS read",
    wName.status === 2 && wName.reason.includes("WORKFLOW_UNRESOLVED") && wName.reason.includes("inline the script") &&
      wLink.status === 2 && wLink.reason.includes("WORKFLOW_UNRESOLVED") && wLink.reason.includes("symlink") && !wLink.reason.includes("ROLE_MISSING") &&
      wPath.status === 2 && wPath.reason.includes("ROLE_MISSING") &&
      wUnscannable.status === 2 && wUnscannable.reason.includes("could not be scanned"),
    `name=${wName.status} link=${wLink.status} path=${wPath.status} unscannable=${wUnscannable.status}`, "M-WF-FOLLOW / M-WF-UNRESOLVED-ADVISORY / M-WF-SCAN-ADVISORY");

  // E3 A5 F1 (2026-10-13): the runtime resolves a Workflow `name` by the `meta.name` declared INSIDE each
  // `*.js` file across the user, project, plugin and built-in registries — never by FILENAME, and never
  // from a `.mjs`. A guard that looked a name up by filename judged a different file than the one that
  // runs, so the `name` source is refused outright: whatever the saved directory holds, a name DENIES.
  const savedDir = path.join(sbE.dir, ".claude", "workflows");
  fs.mkdirSync(savedDir, { recursive: true });
  // A decoy whose FILENAME stem is the name asked for but which declares another meta.name and launches nothing…
  fs.writeFileSync(path.join(savedDir, "decoy-n.js"),
    ["export const meta = { name: 'some-other-name', description: 'decoy' }", "const x = 1"].join("\n"));
  // …beside the file the runtime would actually run for that name: a high-routed role launched at low.
  fs.writeFileSync(path.join(savedDir, "the-real-one.js"),
    ["export const meta = { name: 'decoy-n', description: 'runs' }", "await agent('ROLE: security-review\\nAudit.', {effort: 'low'})"].join("\n"));
  // A filename that matches AND whose one call is correctly routed: still a name, still refused.
  fs.writeFileSync(path.join(savedDir, "routed-n.js"),
    ["export const meta = { name: 'routed-n', description: 'routed' }", "await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})"].join("\n"));
  const nDecoy = fireW({ name: "decoy-n" });
  const nRouted = fireW({ name: "routed-n" });
  const nameDenied = (r) => r.status === 2 && r.reason.includes("WORKFLOW_UNRESOLVED") && r.reason.includes("`name`") &&
    r.reason.includes("inline the script") && r.reason.includes("absolute") && r.reason.includes("scriptPath");
  check("E71b", "F1 NAME SOURCE REFUSED: a Workflow launched by `name` DENIES (WORKFLOW_UNRESOLVED, inline-or-absolute-scriptPath remedy) when a file of that FILENAME holds no agent() call, and when the matching file is correctly routed — the guard never judges a file by name",
    nameDenied(nDecoy) && nameDenied(nRouted) && !nDecoy.reason.includes("EFFORT_MISMATCH"),
    `decoy=${nDecoy.status} routed=${nRouted.status} reason=${nDecoy.reason.slice(0, 160)}`, "M-F1-NAME-LOOKUP");
  // The `.mjs` variant: the runtime never loads one, so a guard reading it judges a file that cannot run.
  fs.writeFileSync(path.join(savedDir, "decoy-m.mjs"),
    ["export const meta = { name: 'decoy-m', description: 'never loaded' }", "const x = 1"].join("\n"));
  const nMjs = fireW({ name: "decoy-m" });
  check("E71c", "F1 NAME SOURCE REFUSED (.mjs decoy): a `name` whose only file is a `.mjs` with no agent() call DENIES rather than passing on the file the runtime never loads",
    nameDenied(nMjs), `mjs=${nMjs.status} reason=${nMjs.reason.slice(0, 160)}`, "M-F1-NAME-LOOKUP");

  // E3 A5 F2 (2026-10-13): a computed member access or computed key reaches a property whose NAME is built
  // at run time, so no identifier token names it and the reflective-token check never fires. Every one
  // whose key is not a single number literal makes the script unscannable — fail-closed.
  const ROUTED_CALL = "await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})";
  const COMPUTED = {
    "identifier-key": ["const k = 'na' + 'me'", "const v = meta[k]"],
    "concatenated-key": ["const v = meta['na' + 'me']"],
    "string-literal-key": ["const v = meta['name']"],
    "optional-computed": ["const v = meta?.['name']"],
    "in-substitution": ["const v = `${meta['na' + 'me']}`"],
    "pattern-key": ["const { ['na' + 'me']: v } = meta"],
    "class-computed-key": ["class C { ['na' + 'me']() { return 1 } }"],
  };
  const computedRuns = Object.entries(COMPUTED).map(([variant, lines]) => {
    const src = wfOf(...lines, ROUTED_CALL);
    const scan = WS ? WS.scanWorkflowScript(src) : null;
    const r = fireW({ script: src });
    return { variant, scanOk: scan ? scan.ok : null, why: scan && !scan.ok ? scan.reason : "", status: r.status,
      denied: r.status === 2 && r.reason.includes("WORKFLOW_UNRESOLVED") && r.reason.includes("could not be scanned") && r.reason.includes("computed") };
  });
  check("E71d", "F2 COMPUTED KEY REFUSED: a computed member access or computed key whose key is not a number literal — identifier, concatenated string, string literal, optional, inside a substitution, in a destructuring pattern, in a class body — makes the script UNSCANNABLE and the Workflow DENIES",
    computedRuns.every((x) => x.scanOk === false && x.why.includes("computed") && x.denied),
    JSON.stringify(computedRuns.map(({ variant, scanOk, status }) => [variant, scanOk, status])), "M-F2-COMPUTED-OPEN");
  // The named prototype and property-descriptor readers reach a property by a string name with no `[`.
  const reflRuns = ["getPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "__lookupGetter__"].map((id) => {
    const r = fireW({ script: wfOf(`const v = Object.${id}(meta)`, ROUTED_CALL) });
    return { id, status: r.status, denied: r.status === 2 && r.reason.includes("WORKFLOW_INDIRECT") && r.reason.includes(id) };
  });
  check("E71e", "F2 STRING-NAMED REFLECTION REFUSED: the prototype and property-descriptor readers each DENY as WORKFLOW_INDIRECT",
    reflRuns.every((x) => x.denied), JSON.stringify(reflRuns.map(({ id, status }) => [id, status])), "M-F2-DESCRIPTOR-IDS");
  // A QUOTED property key names a property with no identifier token and no `[`, so before the fix each of
  // these scanned as "no launches" and the Workflow was ALLOWED (E3 R1 security HIGH, 2026-10-15): the
  // string-keyed destructuring reaches `Function` (or aliases the hook) exactly as `.constructor` does.
  const QUOTED_KEYS = {
    "ctor-destructure": "const {\"constructor\": F} = parallel",
    "ctor-chain": "const {'constructor': G} = parallel; const {'constructor': F} = G",
    "hook-alias": "const {\"agent\": a} = globals",
    "proto": "const {'__proto__': P} = parallel",
    "object-literal-key": "const o = {'eval': parallel}",
  };
  const quotedRuns = Object.entries(QUOTED_KEYS).map(([variant, line]) => {
    const src = wfOf(line, ROUTED_CALL);
    const scan = WS ? WS.scanWorkflowScript(src) : null;
    const r = fireW({ script: src });
    return { variant, flagged: !!(scan && scan.ok && scan.indirect.some((x) => x.why.includes("quoted key"))), status: r.status,
      denied: r.status === 2 && r.reason.includes("WORKFLOW_INDIRECT") && r.reason.includes("quoted key") };
  });
  check("E71g", "QUOTED REFLECTIVE KEY REFUSED: a string-literal property key naming a reflective identifier or a launch hook — `{\"constructor\": F}`, a chained constructor, `{\"agent\": a}`, `__proto__`, an object-literal key — is reported indirect and the Workflow DENIES (WORKFLOW_INDIRECT)",
    quotedRuns.every((x) => x.flagged && x.denied), JSON.stringify(quotedRuns.map(({ variant, flagged, status }) => [variant, flagged, status])), "M-QUOTED-KEY");
  // ALLOW pole for E71g: quoted keys that name no reflective identifier or hook — including the routed
  // call's own quoted option keys — still pass, so the fix cannot be satisfied by refusing every quoted key.
  const QUOTED_OK = wfOf("const o = {\"name\": 'x', 'list': [1, 2]}",
    "await agent('ROLE: explore-search\\nFind it.', {\"effort\": 'medium'})", ROUTED_CALL);
  const qScan = WS ? WS.scanWorkflowScript(QUOTED_OK) : null;
  const qOk = fireW({ script: QUOTED_OK });
  check("E71h", "ALLOW POLE (quoted keys): ordinary quoted keys and quoted option keys PASS untouched, both calls proved",
    qScan && qScan.ok === true && qScan.calls.length === 2 && qScan.indirect.length === 0 && qOk.status === 0 && qOk.reason === "",
    `scan=${qScan && (qScan.ok ? `calls=${qScan.calls.length} indirect=${qScan.indirect.length}` : qScan.reason)} status=${qOk.status} ${qOk.reason.slice(0, 120)}`,
    "M-QUOTED-KEY-OVERBLOCK");
  // A quoted key holding ANY backslash is UNSCANNABLE, never decoded: the hand decoder disagreed with the
  // engine on a lone-CR continuation and on legacy octal (E3 R2 security HIGH, 2026-10-15), each of which
  // spelled `constructor` / `agent` and was ALLOWED. Each row must DENY; the plain benign key must ALLOW.
  const ESCAPED_KEYS = {
    "lone-cr-continuation": "const {\"constr\\\ructor\": F} = parallel",
    "crlf-continuation": "const {\"constr\\\r\nuctor\": F} = parallel",
    "octal-constructor": "const {\"\\143onstructor\": F} = parallel",
    "octal-agent": "const {\"\\141gent\": a} = globals",
    "unicode-constructor": "const {\"\\u0063onstructor\": F} = parallel",
    "out-of-range-codepoint": "const {\"\\u{110000}\": F} = parallel",
  };
  const escRuns = Object.entries(ESCAPED_KEYS).map(([variant, line]) => {
    const src = wfOf(line, ROUTED_CALL);
    let scanOk = null;
    try { scanOk = WS ? WS.scanWorkflowScript(src).ok : null; } catch { scanOk = "threw"; }
    const r = fireW({ script: src });
    return { variant, scanOk, status: r.status, denied: r.status === 2 && r.reason.includes("WORKFLOW_UNRESOLVED") };
  });
  const plainKey = fireW({ script: wfOf("const o = {\"name\": 'x'}", ROUTED_CALL) });
  check("E71i", "ESCAPED QUOTED KEY UNSCANNABLE: a quoted key with a lone-CR or CRLF continuation, a legacy octal escape (constructor, agent), a unicode escape, or an out-of-range code point makes the script UNSCANNABLE and the Workflow DENIES; the same script with a plain benign key ALLOWS",
    escRuns.every((x) => x.scanOk === false && x.denied) && plainKey.status === 0 && plainKey.reason === "",
    JSON.stringify(escRuns.map(({ variant, scanOk, status }) => [variant, scanOk, status])) + ` plain=${plainKey.status}`,
    "M-ESCAPED-KEY");

  // The ALLOW pole for both fixes: inline and absolute-scriptPath launches still pass, including a script
  // that uses array literals, array destructuring, for-of over an array literal, a numeric index and a
  // numeric computed key — none of which can name a property by a run-time string.
  const ALLOWED_SHAPES = wfOf(
    "const xs = ['a', 'b']",
    "const [first, second] = xs",
    "const one = xs[0]",
    "for (const x of ['c', 'd']) { void x }",
    "const o = { [0]: one, list: [1, 2], pair: [first, second] }",
    "const all = await Promise.all([1, 2].map((n) => n * 2))",
    ROUTED_CALL);
  const allowScan = WS ? WS.scanWorkflowScript(ALLOWED_SHAPES) : null;
  const aInline = fireW({ script: ALLOWED_SHAPES });
  const routedPath = path.join(sbE.dir, "routed-script.js");
  fs.writeFileSync(routedPath, ALLOWED_SHAPES);
  const aPath = fireW({ scriptPath: routedPath });
  check("E71f", "ALLOW POLE: an inline script and the same script by absolute scriptPath both PASS untouched — array literals, array destructuring, for-of over an array literal, a numeric index and a numeric computed key are not refused",
    allowScan && allowScan.ok === true && allowScan.calls.length === 1 && allowScan.indirect.length === 0 &&
      aInline.status === 0 && aInline.ctx === "" && aInline.reason === "" && aPath.status === 0 && aPath.ctx === "" && aPath.reason === "",
    `scan=${allowScan && (allowScan.ok ? "ok" : allowScan.reason)} inline=${aInline.status} path=${aPath.status} ${aInline.reason.slice(0, 120)}`,
    "M-F2-OVERBLOCK");

  // The ledger row: one workflow-launch row per Workflow call — agents found + unresolved count.
  const wfPayload = { hook_event_name: "PreToolUse", tool_name: "Workflow", session_id: "s-wf",
    tool_input: { script: wfOf("await agent('ROLE: explore-search\\nx', {effort: 'medium'})", "await agent(p, {effort: 'low'})", "await workflow('c')") } };
  const wfCls = EDL ? EDL.classifyDispatchEvent(wfPayload, DL) : null;
  const wfRec = typeof DL.buildWorkflowLaunchRecord === "function"
    ? DL.buildWorkflowLaunchRecord({ sessionId: "s-wf", generation: null, agentsFound: wfCls?.agentsFound, unresolved: wfCls?.unresolved, scriptSource: wfCls?.scriptSource, nowIso: "2026-10-12T00:00:00.000Z" })
    : null;
  check("E72", "LEDGER: a Workflow call yields ONE workflow-launch row (agents_found 2, unresolved 2 = a non-literal call + a nested workflow), a kind the sink accepts",
    wfCls?.kind === "workflow-launch" && wfRec?.kind === "workflow-launch" && wfRec.agents_found === 2 && wfRec.unresolved === 2 &&
      wfRec.script_source === "script" && DL.RECORD_KINDS.includes("workflow-launch"),
    JSON.stringify({ wfCls, wfRec }), "M-WF-LEDGER");
  const wReg = JSON.parse(fs.readFileSync(path.join(REPO, ".claude/hooks/dispatch-registry.json"), "utf8"));
  const ledgerMatchers = wReg.events.PreToolUse.groups.filter((g) => g.hooks.some((h) => h.command.includes("/emit-dispatch-ledger.js"))).map((g) => g.matcher);
  check("E73", "REGISTRY: the ledger producer's PreToolUse matcher includes Workflow",
    JSON.stringify(ledgerMatchers) === JSON.stringify(["Task|Agent|SendMessage|Workflow"]), JSON.stringify(ledgerMatchers), "M-WF-REG");

  // FAIL-CLOSED: the scanner library missing BLOCKS a Workflow with the self-run restore text.
  const sbW = makeHookSandbox("wf-libs");
  const wRoot = path.join(sbW.dir, "tree");
  fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(wRoot, ".claude", "hooks"), { recursive: true });
  fs.rmSync(path.join(wRoot, ".claude", "hooks", "lib", "workflow-launch-scan.js"), { force: true });
  const wNoLib = spawnHook(sbW, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Workflow", session_id: "s-wfl",
    tool_input: { script: wfOf("await agent('ROLE: explore-search\\nx', {effort: 'medium'})") } }), {}, { raw: true, hook: path.join(wRoot, ".claude", "hooks", "dispatch-contract-guard.js") });
  let wNoLibJson = null;
  try { wNoLibJson = JSON.parse(wNoLib.stdout); } catch {}
  const wNoLibReason = wNoLibJson?.hookSpecificOutput?.permissionDecisionReason || "";
  check("E74", "FAIL-CLOSED WORKFLOW: with lib/workflow-launch-scan.js gone a Workflow is DENIED (UNEVALUABLE) with the self-run restore of THAT library",
    wNoLib.status === 2 && wNoLibReason.includes("UNEVALUABLE") && wNoLibReason.includes("git checkout HEAD -- .claude/hooks/lib/workflow-launch-scan.js"),
    `exit=${wNoLib.status}`, "M-WF-FAILOPEN");

  // RECEIPT DIGEST BINDS THE RESOLVED SCRIPT: a receipt written for a scriptPath's CONTENT does not
  // lift the same path once its content changes, and does lift the content it names.
  const rwFile = path.join(sbE.dir, "receipt-script.js");
  const rwA = wfOf("await agent('Audit A.', {effort: 'high'})");
  const rwB = wfOf("await agent('Audit B.', {effort: 'high'})");
  fs.writeFileSync(rwFile, rwA);
  const rwDigest = documentedDigest({ tool_name: "Workflow", tool_input: { subagent_type: "", prompt: rwA } }, ["agents/effort-routing"]);
  fs.mkdirSync(path.dirname(sbE.receipt), { recursive: true });
  fs.writeFileSync(sbE.receipt, receiptLine(rwDigest, "approved for script A only") + "\n");
  fs.writeFileSync(rwFile, rwB);
  const rwOnB = fireW({ scriptPath: rwFile });
  const rwKept = fs.existsSync(sbE.receipt);
  fs.writeFileSync(rwFile, rwA);
  const rwOnA = fireW({ scriptPath: rwFile });
  check("E75", "WORKFLOW RECEIPT: a receipt bound to a scriptPath's content does not lift the same path with other content, and lifts the content it names",
    rwOnB.status === 2 && rwKept && rwOnA.status === 0 && !fs.existsSync(sbE.receipt),
    `B=${rwOnB.status} kept=${rwKept} A=${rwOnA.status}`, "M-WF-DIGEST: digest the raw tool_input");

  // CODEX RE-TASK (measured on Codex CLI 0.162.1: `collaboration.followup_task({target, message})`
  // re-activates a finished child). Each plausible host spelling projects into the re-task class, so the
  // re-task entry judges it: a bad ROLE to the HIGH-launched lane-r is DENIED, and the in-place re-task
  // the deny names is ALLOWED. Driven through the real projection (`projectPayloads`), not a full run.
  const inPlaceOf = (t) => {
    const m = String(t).match(/in place instead, the follow-up's FIRST line must name a role at the effort it was launched with \(([a-z]+)\): `(ROLE: [a-z0-9-]+)`/);
    return m ? { effort: m[1], line: m[2] } : null;
  };
  const fireFollowup = (tool_name, message) => {
    if (!CNP) return { status: -1, reason: "", ctx: "x", projected: null };
    const [proj] = CNP.projectPayloads({ hook_event_name: "PreToolUse", tool_name, session_id: "s-effort", tool_input: { target: "lane-r", message } });
    return { ...fireE(proj.tool_name, proj.tool_input), projected: proj.tool_name };
  };
  const FOLLOWUP_SPELLINGS = ["collaboration.followup_task", "collaborationfollowup_task", "followup_task"];
  const fu = FOLLOWUP_SPELLINGS.map((name) => {
    const denied = fireFollowup(name, "ROLE: wizard\nPick the next item.");
    const k = inPlaceOf(denied.reason);
    const allowed = k ? fireFollowup(name, `${k.line}\nPick the next item.`) : { status: -1, ctx: "x" };
    return { name, projected: denied.projected, denied: denied.status, code: /ROLE_UNKNOWN/.test(denied.reason), self: selfCorrect(denied.reason), k, allowed: allowed.status, ctx: allowed.ctx };
  });
  check("E76", "CODEX RE-TASK: followup_task in all three spellings projects to the re-task class, is DENIED on a bad ROLE (self-correctable), and the in-place re-task named by the deny is ALLOWED",
    fu.every((x) => x.projected === "SendMessage" && x.denied === 2 && x.code && x.self && x.k?.effort === "high" && x.allowed === 0 && x.ctx === ""),
    JSON.stringify(fu.map((x) => [x.name, x.projected, x.denied, x.k?.line, x.allowed])), "M-FU-PROJECT / M-RT-INPLACE");

  // NESTED SPAWN (measured 2026-10-12: a subagent's own Agent call DOES fire PreToolUse Agent, the ledger
  // recording generation = that subagent's id). The guard judges it exactly as a top-level launch.
  const NEST = { agent_id: "a0123456789abcdefsub", agent_type: "general-purpose", tool_use_id: "toolu-nested" };
  const nDenied = fireE("Agent", { subagent_type: "general-purpose", prompt: BODY, effort: "medium" }, NEST);
  const kn = correctionOf(nDenied.reason);
  const nRelaunch = kn ? fireE("Agent", { subagent_type: "general-purpose", prompt: `${kn.line}\n${BODY}`, effort: kn.effort }, NEST) : { status: -1, ctx: "x" };
  check("E77", "NESTED SPAWN: a subagent's own launch (agent_id set) with no ROLE line is DENIED with the same self-correction, and the relaunch from the deny is ALLOWED",
    nDenied.status === 2 && nDenied.reason.includes("ROLE_MISSING") && selfCorrect(nDenied.reason) && nRelaunch.status === 0 && nRelaunch.ctx === "",
    `deny=${nDenied.status} relaunch=${nRelaunch.status} k=${JSON.stringify(kn)}`, "M-NEST-SKIP");

  // ── E3 R2 security (2026-10-12): the Workflow scanner must PROVE a script holds nothing but direct, fully
  // literal agent()/workflow() calls. Each script below hides a launch (or its effort) from a scanner that
  // only FINDS calls; each must DENY, self-correctably, and never pass as a script with nothing to judge.
  const denies = (r) => r.status === 2 && selfCorrect(r.reason) && namesEveryRole(r.reason);
  const statusesOf = (o) => Object.entries(o).map(([k, r]) => `${k}=${r.status}`).join(" ");
  const NOROLE = "'Do it.', {effort: 'medium'}";
  const h1 = {
    alias: fireW({ script: wfOf(`const launch = agent; await launch(${NOROLE})`) }),
    map: fireW({ script: wfOf("const prompts = ['Do it.']", "await Promise.all(prompts.map(agent))") }),
    optional: fireW({ script: wfOf(`await agent?.(${NOROLE})`) }),
    member: fireW({ script: wfOf(`await agent.call(null, ${NOROLE})`) }),
    comma: fireW({ script: wfOf(`await (0, agent)(${NOROLE})`) }),
    array: fireW({ script: wfOf(`await [agent][0](${NOROLE})`) }),
    tagged: fireW({ script: wfOf("await agent`ROLE: explore-search\\nFind it.`") }),
    ctxMember: fireW({ script: wfOf(`await ctx.agent(${NOROLE})`) }),
    paren: fireW({ script: wfOf(`await (agent)(${NOROLE})`) }),
    escaped: fireW({ script: wfOf(`await \\u0061gent(${NOROLE})`) }),
    nbsp: fireW({ script: wfOf("await agent\u00a0('ROLE: explore-search\\nFind it.', {effort: 'medium'})") }),
    lsep: fireW({ script: wfOf(`// note\u2028await agent(${NOROLE})`) }),
    cr: fireW({ script: wfOf(`// note\rawait agent(${NOROLE})`) }),
    global: fireW({ script: wfOf(`await globalThis['ag' + 'ent'](${NOROLE})`) }),
    evaled: fireW({ script: wfOf(`await eval("ag" + "ent")(${NOROLE})`) }),
    workflowAlias: fireW({ script: wfOf("const w = workflow; await w('child')") }),
  };
  check("E78", "WORKFLOW PROOF (H1): an aliased, mapped, optional, member, comma, indexed, tagged-template, `ctx.agent`, parenthesized, escaped, non-ASCII-spaced, line-separator-hidden, reflective or aliased-workflow launch DENIES, self-correctably — none passes as a script with nothing to judge",
    Object.values(h1).every(denies) && h1.escaped.reason.includes("an identifier escape or stray backslash"),
    statusesOf(h1), "M-WFP-OCCURRENCE / M-WFP-CHARSET / M-WFP-COMMENT-END / M-WFP-REFLECT / M-WFP-ESCAPE-START");
  const h2 = {
    inPrompt: fireW({ script: wfOf("await agent(`ROLE: explore-search\\nFind it. ${await agent('Do it.', {effort: 'low'})}`, {effort: 'medium'})") }),
    bare: fireW({ script: wfOf("const s = `${agent('Do it.', {effort: 'low'})}`") }),
  };
  check("E79", "WORKFLOW PROOF (H2): an agent() call inside a template substitution DENIES — substitutions are tokenized, never skipped",
    Object.values(h2).every(denies), statusesOf(h2), "M-WFP-SUBST-SKIP");
  const h3 = {
    afterBrace: fireW({ script: wfOf(`const x = {}/1; await agent(${NOROLE})//`) }),
    afterIncrement: fireW({ script: wfOf(`let i = 0; i++ /1; await agent(${NOROLE})//`) }),
    afterOf: fireW({ script: wfOf(`const of = 4; const q = of /2; await agent(${NOROLE})//`) }),
  };
  const h3Divide = fireW({ script: wfOf("const half = (4 + 2) / 2", "await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})") });
  const h3Regex = fireW({ script: wfOf("const s = 'x'", "if (s) /agent\\(/.test(s)", "await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})") });
  check("E80", "WORKFLOW PROOF (H3): a `/` whose regex-or-divide reading is ambiguous (after `}`, `++` or a contextual word like `of`) DENIES; an unambiguous divide after `)` and a regex after `if (…)` still pass a correct script",
    Object.values(h3).every(denies) && h3Divide.status === 0 && h3Divide.ctx === "" && h3Regex.status === 0 && h3Regex.ctx === "",
    `${statusesOf(h3)} divide=${h3Divide.status} regexAfterIf=${h3Regex.status}`, "M-WFP-REGEX-GUESS / M-WFP-CONTEXTUAL / M-WFP-PAREN-HEAD");
  const ROUTED = "'ROLE: explore-search\\nFind it.'";
  const h4 = {
    spreadAfter: fireW({ script: wfOf("const o = {effort: 'high'}", `await agent(${ROUTED}, {effort: 'medium', ...o})`) }),
    getter: fireW({ script: wfOf(`await agent(${ROUTED}, {effort: 'medium', get effort() { return 'high' }})`) }),
    escapedKey: fireW({ script: wfOf(`await agent(${ROUTED}, {effort: 'medium', eff\\u006frt: 'high'})`) }),
    duplicate: fireW({ script: wfOf(`await agent(${ROUTED}, {effort: 'medium', 'effort': 'high'})`) }),
  };
  check("E81", "WORKFLOW PROOF (H4): a spread, a getter, an escaped or a duplicate key anywhere in agent()'s options DENIES, even after a literal routed effort",
    Object.values(h4).every(denies) && h4.escapedKey.reason.includes("an identifier written with an escape"),
    statusesOf(h4), "M-WFP-OPTIONS / M-WFP-ESCAPE-MID / M-WFP-DUP+FIRSTWINS");
  const okScript = wfOf(`await agent(${ROUTED}, {effort: 'medium'})`);
  const h5 = {
    scriptAndPath: fireW({ script: okScript, scriptPath: path.join(sbE.dir, "no-such.js") }),
    scriptAndName: fireW({ script: okScript, name: "other" }),
    empty: fireW({ script: "" }),
    blank: fireW({ script: " \n " }),
  };
  check("E82", "WORKFLOW PROOF (H5): more than one of script/scriptPath/name, or an empty script, DENIES",
    Object.values(h5).every(denies), statusesOf(h5), "M-WFP-SOURCES");
  fs.writeFileSync(path.join(sbE.dir, "rel-script.js"), okScript);
  const m1 = fireW({ scriptPath: "rel-script.js" });
  const m1Abs = fireW({ scriptPath: path.join(sbE.dir, "rel-script.js") });
  check("E83", "WORKFLOW PROOF (M1): a RELATIVE scriptPath DENIES (the hook and the runtime may resolve it against different roots); the same script by absolute path passes",
    denies(m1) && m1.reason.includes("a relative scriptPath is not resolved here") && m1Abs.status === 0 && m1Abs.ctx === "", `rel=${m1.status} abs=${m1Abs.status}`, "M-WFP-RELATIVE");
  const fireSpawn = (tool_name, input) => {
    if (!CNP) return { status: -1, reason: "", ctx: "x", projected: null };
    const [proj] = CNP.projectPayloads({ hook_event_name: "PreToolUse", tool_name, session_id: "s-effort", tool_input: input });
    return { ...fireE(proj.tool_name, proj.tool_input), projected: proj.tool_name };
  };
  const m2 = fireSpawn("collaboration.spawn_agent", { agent_type: "worker", message: BODY, reasoning_effort: "medium" });
  const km2 = correctionOf(m2.reason);
  const m2Fixed = km2 ? fireSpawn("collaboration.spawn_agent", { agent_type: "worker", message: `${km2.line}\n${BODY}`, reasoning_effort: km2.effort }) : { status: -1, ctx: "x" };
  check("E84", "CODEX SPAWN (M2): `collaboration.spawn_agent` projects to the launch class — no ROLE is DENIED, and the relaunch from the deny is ALLOWED",
    m2.projected === "Agent" && m2.status === 2 && m2.reason.includes("ROLE_MISSING") && m2Fixed.status === 0 && m2Fixed.ctx === "",
    `projected=${m2.projected} deny=${m2.status} fixed=${m2Fixed.status}`, "M-SPAWN-DOTTED");
  const m3 = {
    lead: fireE("Agent", { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit.", effort: " high" }),
    trail: fireE("Agent", { subagent_type: "general-purpose", prompt: "ROLE: security-review\nAudit.", effort: "high\n" }),
    wf: fireW({ script: wfOf("await agent('ROLE: security-review\\nAudit.', {effort: ' high'})") }),
  };
  check("E85", "RAW EFFORT (M3): an effort carrying whitespace is compared RAW and DENIED — the gate never judges a level the host was not given",
    Object.values(m3).every((r) => r.status === 2 && r.reason.includes("EFFORT_MISMATCH")), statusesOf(m3), "M-EFFORT-TRIM");
  // L4: a guard that THROWS mid-launch denies; a payload it cannot read (no launch identified) still passes.
  const sbThr = makeHookSandbox("throws");
  const tRoot = path.join(sbThr.dir, "tree");
  fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(tRoot, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(tRoot, ".claude", "hooks", "lib", "instruct-and-wait.js"),
    "module.exports = { emit() { throw new Error('renderer exploded'); } };\n");
  const tHook = path.join(tRoot, ".claude", "hooks", "dispatch-contract-guard.js");
  const tRun = spawnHook(sbThr, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", session_id: "s-thr",
    tool_input: { subagent_type: "general-purpose", prompt: "Do it.", effort: "medium" } }), {}, { raw: true, hook: tHook });
  const tJunk = spawnHook(sbThr, "not json at all", {}, { raw: true, hook: tHook });
  // The throw reaches `lib/guard-runner.js::runGuard`, the one refusal authority for an ending that is
  // not a verdict: exit 2 naming the guard and the thrown error. (The guard's own hand-built
  // UNEVALUABLE refusal for this ending is gone; in the engine the DISPATCHER refuses the crashed row.)
  check("E86", "FAIL-CLOSED (L4): a guard that THROWS while judging a launch is REFUSED by the run boundary, and an unreadable payload is REFUSED too",
    tRun.status === 2 && tRun.stderr.includes("[guard-runner] DENY dispatch-contract-guard: dispatch-contract-guard crashed before reaching a verdict") &&
      tRun.stderr.includes("renderer exploded") && !/"continue"\s*:\s*true/.test(tRun.stdout) &&
      tJunk.status === 2 && tJunk.stderr.includes("could not read its hook payload"),
    `throw=${tRun.status} junk=${tJunk.status}`, "M-CATCH-OPEN (unwrap runGuard → the throw and the junk pass)");

  // ── E3 R2 correctness addenda (2026-10-12) ─────────────────────────────────────────────────
  /** Fire one hook entry living in a sandbox tree, timing the run (a stall's reach proof). */
  const fireIn = (sb, hook, tool_name, tool_input, extra = {}) => {
    const t0 = Date.now();
    const r = spawnHook(sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name, session_id: "s-add", tool_input, ...extra }), {}, { raw: true, hook });
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, ms, ctx: json?.hookSpecificOutput?.additionalContext || "",
      reason: json?.hookSpecificOutput?.permissionDecisionReason || "" };
  };
  /** A sandbox holding a COMMITTED copy of the shipped hooks, so a deny's own `git checkout HEAD -- …` restores it. */
  const gitTree = (label) => {
    const sb = makeHookSandbox(label);
    fs.cpSync(path.join(REPO, ".claude", "hooks"), path.join(sb.dir, ".claude", "hooks"), { recursive: true });
    spawnSync("git", ["add", "-A"], { cwd: sb.dir, stdio: "ignore" });
    const c = spawnSync("git", ["commit", "-q", "-m", "shipped hooks"], { cwd: sb.dir, encoding: "utf8" });
    return { sb, committed: c.status === 0, launch: path.join(sb.dir, ".claude", "hooks", "dispatch-contract-guard.js"),
      retask: path.join(sb.dir, ".claude", "hooks", "dispatch-retask-guard.js"), lib: (f) => path.join(sb.dir, ".claude", "hooks", "lib", f) };
  };
  /** The agent's restore: run exactly the `git checkout HEAD -- <path>` the deny text names, in the tree. */
  const restoreFrom = (tree, text) => {
    const m = String(text).match(/`git checkout HEAD -- ([^`\s]+)`/);
    if (!m) return false;
    return spawnSync("git", ["checkout", "HEAD", "--", m[1]], { cwd: tree.sb.dir, stdio: "ignore" }).status === 0;
  };
  /** The relaunch a deny text dictates for a Task/Agent launch: its corrected header, the brief body unchanged. */
  const bodyOf = (prompt) => {
    const ls = String(prompt).split("\n");
    while (ls.length > 0 && /^\s*(ROLE:|EFFORT-OVERRIDE:)/.test(ls[0])) ls.shift();
    return ls.join("\n");
  };
  const relaunchOf = (text, ti) => {
    const k = correctionOf(text);
    if (!k) return null;
    const out = { ...ti, prompt: `${k.line}\n${bodyOf(ti.prompt)}`, effort: k.effort };
    if (ti.subagent_type === "fork" && text.includes("Launch a non-fork subagent")) out.subagent_type = "general-purpose";
    return out;
  };
  /** The script a Workflow deny dictates: ONE direct, literal agent() call built from the deny's own role + effort. */
  const scriptFrom = (text) => {
    const k = correctionOf(text);
    return k ? wfOf(`await agent('${k.line}\\nFind it.', {effort: '${k.effort}'})`) : null;
  };
  const passed = (r) => r.status === 0 && r.ctx === "" && r.reason === "";

  // E76b — the Codex re-task spellings (follow-up AND message, dotted included) each reach RETASK_EFFORT_MISMATCH.
  const RETASK_SPELLINGS = ["collaboration.followup_task", "collaborationfollowup_task", "followup_task",
    "send_message", "collaborationsend_message", "collaboration.send_message"];
  const fuMis = RETASK_SPELLINGS.map((name) => {
    const r = fireFollowup(name, "ROLE: mechanical-receipt\nWrite it.");
    return { name, projected: r.projected, status: r.status, code: r.reason.includes("RETASK_EFFORT_MISMATCH") };
  });
  check("E76b", "CODEX RE-TASK EFFORT: every follow-up and message spelling (dotted, concatenated, bare) projects to SendMessage and a LOW role to a HIGH-launched agent DENIES with RETASK_EFFORT_MISMATCH",
    fuMis.every((x) => x.projected === "SendMessage" && x.status === 2 && x.code),
    JSON.stringify(fuMis.map((x) => [x.name, x.projected, x.status, x.code])), "M-SEND-DOTTED / M-FU-PROJECT");

  // E86b — the RE-TASK scope keeps `on_incomplete: continue`: a guard that throws mid-follow-up passes it.
  const tRetask = fireIn(sbThr, path.join(tRoot, ".claude", "hooks", "dispatch-retask-guard.js"), "SendMessage",
    { to: "never-launched-peer", message: "ROLE: wizard\nPick the next item." });
  check("E86b", "RE-TASK FAIL-OPEN KEPT: a guard that THROWS while judging a ROLE-declaring follow-up still PASSES it (exit 0, continue) — only the launch scope fails closed",
    tRetask.status === 0 && tRetask.json?.continue === true, `retask=${tRetask.status}`, "M-RETASK-CATCH-DENY");

  // E87 — the LAUNCH run past its 4000ms budget is a budget REFUSAL from `lib/guard-runner.js::runGuard`;
  // the re-task scope's own fail-open timer PASSES. The launch reads its payload through the runner, so its
  // stall is a stdin that never ends (openStdin); the re-task entry keeps its bounded reader, stalled here
  // with a live handle so its own 4000ms timer is the only thing that can end that run.
  const STALLED_READER = "module.exports = { readStdinBounded: () => new Promise(() => { setInterval(() => {}, 1000); }) };\n";
  const toTree = gitTree("timeout");
  fs.writeFileSync(toTree.lib("read-stdin-bounded.js"), STALLED_READER);
  const OK_TI = { subagent_type: "general-purpose", prompt: "ROLE: explore-search\nFind the callers.", effort: "medium" };
  /** Start an entry with its payload written but stdin NEVER closed, timing the run. */
  const fireStalled = (tree, hook, tool_name, tool_input) => {
    const t0 = Date.now();
    const r = spawnHook(tree.sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name, session_id: "s-open", tool_input }),
      {}, { raw: true, hook, openStdin: true });
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, ms, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
  /** The runner's budget refusal: exit 2, the guard named, both verbatim budget sentences, no allow. */
  const budgetRefused = (r) => r.status === 2 &&
    r.stderr.includes("[guard-runner] DENY dispatch-contract-guard: dispatch-contract-guard did not reach a verdict within its budget") &&
    r.stderr.includes("a guard time-out under load is a budget refusal, not a deny") &&
    r.stderr.includes("Retry once; if it recurs, report dispatch-contract-guard's budget and wait for the user") &&
    !/"continue"\s*:\s*true/.test(r.stdout);
  const toDeny = fireStalled(toTree, toTree.launch, "Agent", OK_TI);
  const toRetask = fireIn(toTree.sb, toTree.retask, "SendMessage", { to: "lane-r", message: "ROLE: wizard\nx" });
  check("E87", "FAIL-CLOSED BUDGET: a launch run past its 4000ms budget is REFUSED by the run boundary (exit 2, budget text, Retry); the re-task scope's own timer still PASSES",
    toTree.committed && budgetRefused(toDeny) && toDeny.ms >= 4000 &&
      toRetask.status === 0 && toRetask.json?.continue === true && toRetask.ms >= 4000,
    `launch=${toDeny.status}/${toDeny.ms}ms retask=${toRetask.status}/${toRetask.ms}ms`, "M-TIMEOUT-OPEN (unwrap runGuard → the stalled launch waits for the host kill)");

  // E88 — the security reviewer's claim, measured: `main` awaits only the stdin read, so a SYNCHRONOUS stall
  // after it (4500ms, past TIMEOUT_MS) cannot be preempted by the timer — the launch is judged and passes.
  const stTree = gitTree("sync-stall");
  fs.renameSync(stTree.lib("effort-routing.js"), stTree.lib("effort-routing-real.js"));
  fs.writeFileSync(stTree.lib("effort-routing.js"),
    "const t0 = Date.now(); while (Date.now() - t0 < 4500) {}\nmodule.exports = require('./effort-routing-real.js');\n");
  const stRun = fireIn(stTree.sb, stTree.launch, "Agent", OK_TI);
  check("E88", "TIMER REACH: a synchronous 4500ms stall AFTER the stdin read runs to a normal verdict — the 4000ms timer cannot fire there (a correct launch exits 0, untouched)",
    stRun.ms >= 4500 && passed(stRun), `exit=${stRun.status} ms=${stRun.ms} reason=${stRun.reason.slice(0, 80)}`, "(none — a measurement)");

  // E89 — with an INVALID table, a Workflow script holding only a nested workflow() or only an indirect launch
  // still reports TABLE_INVALID (the check counts every launch kind, not only direct calls).
  const m9Tree = gitTree("m9");
  fs.writeFileSync(m9Tree.lib("effort-routing-policy.json"), JSON.stringify({ schema_version: 1, roles: { "security-review": "ultra" } }));
  const m9 = {
    nested: fireIn(m9Tree.sb, m9Tree.launch, "Workflow", { script: wfOf("await workflow('child')") }),
    indirect: fireIn(m9Tree.sb, m9Tree.launch, "Workflow", { script: wfOf(`const launch = agent; await launch(${NOROLE})`) }),
  };
  check("E89", "TABLE_INVALID ON EVERY LAUNCH KIND: with the table invalid, a nested-only and an indirect-only Workflow script each DENY with TABLE_INVALID",
    Object.values(m9).every((r) => r.status === 2 && r.reason.includes("TABLE_INVALID")), statusesOf(m9), "M9-CALLS-ONLY");

  // E90 — a stdin that never ends: the LAUNCH entry reads through the run boundary, which has no
  // reader timer of its own and refuses at its 4000ms budget; the re-task entry's REAL reader resolves its
  // open-no-EOF timer (2000ms) and still PASSES; and a payload that arrives whole but does not parse is
  // REFUSED at the launch (the fail-closed migration inverted it: no verdict, never a pass).
  // spawnHook's openStdin producer writes the FULL payload bytes and never closes stdin.
  const rtTree = gitTree("read-timeout");
  const fireOpen = (hook, tool_name, tool_input) => {
    const t0 = Date.now();
    const r = spawnHook(rtTree.sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name, session_id: "s-open", tool_input }),
      {}, { raw: true, hook, openStdin: true });
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    return { status: r.status, json, ms, ctx: json?.hookSpecificOutput?.additionalContext || "",
      reason: json?.hookSpecificOutput?.permissionDecisionReason || "", stdout: r.stdout || "", stderr: r.stderr || "" };
  };
  const rtDeny = fireOpen(rtTree.launch, "Agent", OK_TI);
  const rtRetask = fireOpen(rtTree.retask, "SendMessage", { to: "lane-r", message: "ROLE: wizard\nx" });
  const rtWhole = fireIn(rtTree.sb, rtTree.launch, "Agent", OK_TI, {});
  const junkRun = spawnHook(rtTree.sb, '{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":', {}, { raw: true, hook: rtTree.launch });
  check("E90", "FAIL-CLOSED OPEN STDIN: a launch whose stdin never ends is REFUSED at the 4000ms run budget; the re-task scope's reader timer still PASSES it; a whole-but-unparseable launch payload is REFUSED; a whole payload passes",
    rtTree.committed && rtDeny.status === 2 && rtDeny.stderr.includes("dispatch-contract-guard did not reach a verdict within its budget") &&
      rtDeny.stderr.includes("Retry once; if it recurs, report") && rtDeny.ms >= 4000 &&
      rtRetask.status === 0 && rtRetask.json?.continue === true && rtRetask.ms >= 2000 &&
      junkRun.status === 2 && (junkRun.stderr || "").includes("dispatch-contract-guard could not read its hook payload") && passed(rtWhole),
    `launch=${rtDeny.status}/${rtDeny.ms}ms retask=${rtRetask.status}/${rtRetask.ms}ms junk=${junkRun.status} whole=${rtWhole.status}`, "M-READ-TIMEOUT-OPEN");

  // ── A-1: EVERY effort-routing deny code relaunches successfully from its OWN deny text alone. Each relaunch
  // is built only from what the text names (corrected line + effort, the restore command, the remedy shape).
  const a1 = (code, variant, deny, relaunch, extra = true) => check(`A1-${code}-${variant}`,
    `SELF-CORRECT ${code} (${variant}): the deny names its correction and the relaunch built from that text alone is ALLOWED`,
    deny.status === 2 && deny.reason.includes(code) && extra && relaunch && passed(relaunch),
    `deny=${deny.status} relaunch=${relaunch ? relaunch.status : "none"} ${relaunch ? relaunch.reason.slice(0, 80) : ""}`);
  const launchA1 = (code, variant, ti) => {
    const d = fireE("Agent", ti);
    const fixed = relaunchOf(d.reason, ti);
    a1(code, variant, d, fixed ? fireE("Agent", fixed) : null, selfCorrect(d.reason));
  };
  launchA1("ROLE_MISSING", "no-role-line", { subagent_type: "general-purpose", prompt: BODY, effort: "high" });
  launchA1("ROLE_MALFORMED", "level-in-line", { subagent_type: "general-purpose", prompt: `ROLE: security-review (high)\n${BODY}`, effort: "high" });
  launchA1("ROLE_UNKNOWN", "not-in-table", { subagent_type: "general-purpose", prompt: `ROLE: wizard\n${BODY}`, effort: "high" });
  launchA1("EFFORT_MISSING", "no-effort", { subagent_type: "general-purpose", prompt: `ROLE: extraction\n${BODY}` });
  launchA1("EFFORT_MISMATCH", "plain", { subagent_type: "general-purpose", prompt: `ROLE: extraction\n${BODY}`, effort: "high" });
  launchA1("EFFORT_MISMATCH", "override", { subagent_type: "general-purpose", prompt: `ROLE: extraction\nEFFORT-OVERRIDE: high — r\n${BODY}`, effort: "medium" });
  launchA1("EFFORT_INAPPLICABLE", "fork", { subagent_type: "fork", prompt: `ROLE: security-review\n${BODY}`, effort: "high" });
  launchA1("OVERRIDE_MALFORMED", "no-reason", { subagent_type: "general-purpose", prompt: `ROLE: extraction\nEFFORT-OVERRIDE: low\n${BODY}`, effort: "low" });
  // OVERRIDE_UNRECORDED — the use ledger is unwritable (a directory), so the override is refused.
  {
    const ti = { subagent_type: "general-purpose", prompt: `ROLE: mechanical-receipt\nEFFORT-OVERRIDE: high — needs judgement\n${BODY}`, effort: "high" };
    const d = fireIn(sbU, HOOK, "Agent", ti);
    const fixed = relaunchOf(d.reason, ti);
    a1("OVERRIDE_UNRECORDED", "ledger-unwritable", d, fixed ? fireIn(sbU, HOOK, "Agent", fixed) : null,
      d.reason.includes("SELF-CORRECT (no human step needed)"));
  }
  // TABLE_INVALID and UNEVALUABLE (library missing): restore from the deny's own command, then relaunch.
  {
    const tr = gitTree("a1-table");
    fs.writeFileSync(tr.lib("effort-routing-policy.json"), JSON.stringify({ schema_version: 1, roles: { "security-review": "ultra" } }));
    const d = fireIn(tr.sb, tr.launch, "Agent", OK_TI);
    a1("TABLE_INVALID", "bad-value", d, restoreFrom(tr, d.reason) ? fireIn(tr.sb, tr.launch, "Agent", OK_TI) : null);
  }
  {
    const tr = gitTree("a1-nolib");
    fs.rmSync(tr.lib("effort-routing.js"), { force: true });
    const d = fireIn(tr.sb, tr.launch, "Agent", OK_TI);
    a1("UNEVALUABLE", "library-missing", d, restoreFrom(tr, d.reason) ? fireIn(tr.sb, tr.launch, "Agent", OK_TI) : null);
  }
  // RUN-BOUNDARY REFUSALS (fail-closed migration). A throw, a run past budget and a stdin that never
  // ends are no longer refused by this guard's own hand-built UNEVALUABLE text: they reach
  // `lib/guard-runner.js::runGuard`, the one refusal authority for an ending that is not a verdict (in the
  // engine, the DISPATCHER's refusal — which also carries the restore line for a dirty guard). Each pole
  // below is a standalone run, and each recovery is the one that refusal names or implies.
  // (a) guard threw: refused, guard + error named; restoring the shipped hooks returns the normal
  //     ROLE_MISSING deny, whose own corrected line relaunches ALLOWED.
  {
    const tr = gitTree("a1-threw");
    fs.writeFileSync(tr.lib("instruct-and-wait.js"), "module.exports = { emit() { throw new Error('renderer exploded'); } };\n");
    const ti = { subagent_type: "general-purpose", prompt: BODY, effort: "medium" };
    const t0 = spawnHook(tr.sb, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", session_id: "s-add", tool_input: ti }), {}, { raw: true, hook: tr.launch });
    const crashed = t0.status === 2 && (t0.stderr || "").includes("dispatch-contract-guard crashed before reaching a verdict") && (t0.stderr || "").includes("renderer exploded");
    const restored = crashed && spawnSync("git", ["checkout", "HEAD", "--", ".claude/hooks/"], { cwd: tr.sb.dir, stdio: "ignore" }).status === 0;
    const d3 = restored ? fireIn(tr.sb, tr.launch, "Agent", ti) : null;
    const fixed = d3 && d3.reason.includes("ROLE_MISSING") ? relaunchOf(d3.reason, ti) : null;
    const allowed = fixed ? fireIn(tr.sb, tr.launch, "Agent", fixed) : null;
    check("A1-RUNNER-guard-threw", "RUN BOUNDARY (throw): refused exit 2 naming the guard and the error; after the hooks are restored the normal deny's own correction relaunches ALLOWED",
      crashed && restored && allowed && passed(allowed), `refused=${t0.status} restored=${restored} relaunch=${allowed ? allowed.status : "none"}`);
  }
  // (b) internal budget: the refusal says "Retry once; if it recurs, report" — the same launch, its payload delivered whole, is ALLOWED.
  {
    const retried = fireIn(toTree.sb, toTree.launch, "Agent", OK_TI);
    check("A1-RUNNER-internal-budget", "RUN BOUNDARY (budget): refused with the verbatim budget sentences and Retry; the retried launch is ALLOWED",
      budgetRefused(toDeny) && passed(retried), `refused=${toDeny.status} retry=${retried.status}`);
  }
  // (c) stdin that never ends: the same refusal, the same Retry; the retry with the payload whole is ALLOWED.
  {
    const retried = fireIn(rtTree.sb, rtTree.launch, "Agent", OK_TI);
    check("A1-RUNNER-open-stdin", "RUN BOUNDARY (open stdin): refused at the budget with Retry; the retried launch is ALLOWED",
      rtDeny.status === 2 && rtDeny.stderr.includes("Retry once; if it recurs, report") && passed(retried), `refused=${rtDeny.status} retry=${retried.status}`);
  }
  // Every Workflow deny: the relaunch is the one-direct-literal-call script the deny's remedy shape asks for.
  const wfA1 = (code, variant, tool_input, shape) => {
    const d = fireW(tool_input);
    const s = scriptFrom(d.reason);
    a1(code, variant, d, s ? fireW({ script: s }) : null, d.reason.includes(shape));
  };
  wfA1("WORKFLOW_UNRESOLVED", "saved-name", { name: "no-such-saved-workflow" }, "inline the script");
  wfA1("WORKFLOW_UNRESOLVED", "unscannable", { script: wfOf("await agent('ROLE: explore-search\\nunterminated, {effort: 'medium'})") }, "inline the script");
  wfA1("WORKFLOW_UNRESOLVED", "two-sources", { script: okScript, name: "other" }, "pass exactly one");
  wfA1("WORKFLOW_UNRESOLVED", "relative-path", { scriptPath: "rel-script.js" }, "absolute");
  wfA1("WORKFLOW_UNRESOLVED", "empty-script", { script: " \n " }, "pass exactly one");
  wfA1("WORKFLOW_UNEVALUATED", "non-literal-prompt", { script: wfOf("await agent(task.prompt, {effort: 'high'})") }, "make the ROLE line and the effort literal");
  wfA1("WORKFLOW_UNEVALUATED", "non-literal-options", { script: wfOf("await agent('ROLE: extraction\\nx', {...opts})") }, "make the ROLE line and the effort literal");
  wfA1("WORKFLOW_NESTED_UNRESOLVED", "child-workflow", { script: wfOf("await workflow('child')") }, "inline the child's agent() calls");
  wfA1("WORKFLOW_INDIRECT", "alias", { script: wfOf(`const launch = agent; await launch(${NOROLE})`) }, "call `agent(...)` directly");
  wfA1("WORKFLOW_INDIRECT", "tagged-template", { script: wfOf("await agent`ROLE: explore-search\\nFind it.`") }, "call `agent(...)` directly");
  wfA1("ROLE_MISSING", "workflow-call", { script: wfOf("await agent('Find the callers.', {effort: 'medium'})") }, "agent(prompt, {effort");
  wfA1("EFFORT_MISMATCH", "workflow-call", { script: wfOf("await agent('ROLE: security-review\\nAudit.', {effort: 'low'})") }, "agent(prompt, {effort");
  wfA1("EFFORT_MISSING", "workflow-call", { script: wfOf("await agent('ROLE: security-review\\nAudit.')") }, "agent(prompt, {effort");
  wfA1("EFFORT_MISMATCH", "workflow-hidden-override", { script: wfOf("await agent(`ROLE: extraction\\n${body}`, {effort: 'high'})") }, "write the override line literally");
  {
    // Restore, relaunch unchanged, then follow the nested-workflow deny that the restored table now returns.
    const wti = { script: wfOf("await workflow('child')") };
    const d = fireIn(m9Tree.sb, m9Tree.launch, "Workflow", wti);
    const d2 = restoreFrom(m9Tree, d.reason) ? fireIn(m9Tree.sb, m9Tree.launch, "Workflow", wti) : null;
    const s = d2 && d2.reason.includes("WORKFLOW_NESTED_UNRESOLVED") ? scriptFrom(d2.reason) : null;
    a1("TABLE_INVALID", "workflow", d, s ? fireIn(m9Tree.sb, m9Tree.launch, "Workflow", { script: s }) : null);
  }
  {
    const tr = gitTree("a1-noscan");
    fs.rmSync(tr.lib("workflow-launch-scan.js"), { force: true });
    const okWf = { script: wfOf("await agent('ROLE: explore-search\\nFind it.', {effort: 'medium'})") };
    const d = fireIn(tr.sb, tr.launch, "Workflow", okWf);
    a1("UNEVALUABLE", "workflow-scanner-missing", d, restoreFrom(tr, d.reason) ? fireIn(tr.sb, tr.launch, "Workflow", okWf) : null);
  }
  // RE-TASK denies to the HIGH-launched lane-r: a fresh launch (RETASK_EFFORT_MISMATCH) or the in-place line.
  {
    const d = fireE("SendMessage", { to: "lane-r", message: "ROLE: mechanical-receipt\nWrite it." });
    const k = correctionOf(d.reason);
    a1("RETASK_EFFORT_MISMATCH", "fresh-launch", d,
      k ? fireE("Agent", { subagent_type: "general-purpose", prompt: `${k.line}\nWrite it.`, effort: k.effort }) : null,
      d.reason.includes("FRESH (non-fork)"));
    const ip = inPlaceOf(d.reason);
    a1("RETASK_EFFORT_MISMATCH", "in-place", d, ip ? fireE("SendMessage", { to: "lane-r", message: `${ip.line}\nWrite it.` }) : null);
  }
  for (const [code, variant, message] of [
    ["ROLE_UNKNOWN", "retask", "ROLE: wizard\nPick the next item."],
    ["ROLE_MALFORMED", "retask", "ROLE: security-review (high)\nPick the next item."],
    ["OVERRIDE_MALFORMED", "retask", "ROLE: extraction\nEFFORT-OVERRIDE: low\nPick the next item."],
  ]) {
    const d = fireE("SendMessage", { to: "lane-r", message });
    const ip = inPlaceOf(d.reason);
    a1(code, variant, d, ip ? fireE("SendMessage", { to: "lane-r", message: `${ip.line}\nPick the next item.` }) : null);
  }
  try { fs.rmSync(sbE.receipt, { force: true }); } catch {}
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
