#!/usr/bin/env node
/**
 * burndown-build — the burndown block is a GENERATED ARTIFACT, not a count someone did.
 *
 * WHAT THIS STOPS. Not a wrong number — a MOVING DENOMINATOR. Asked the same
 * question once, an agent produced 110, then 48, then 14/15/19, then 2/3/3. Every
 * figure was arithmetically correct and none were reconcilable, because each pass
 * silently chose its own population and none of them stated which. "Be more
 * careful" does not fix that: the cure is to make the count a generated artifact
 * that reports its own quote, so a bespoke count is STRUCTURALLY IMPOSSIBLE rather
 * than discouraged. `rules/burndown-integrity.md` is the binding layer; THIS is the
 * load-bearing half.
 *
 * WHY A DECLARED MANIFEST AND NOT A DIRECTORY GLOB. The reference implementation
 * this improves on discovered 84 JSON sources by globbing a directory. A glob makes
 * adding a source invisible — a file appears and every count moves, with no diff a
 * reviewer could have objected to. Here the source list is DECLARED, so adding one
 * is a reviewable change, and every declared file must be committed and unmodified
 * or the build REFUSES.
 *
 * REFUSAL IS EXIT 2 AND IT IS NOT A PASS. A build that refuses prints
 * `UNRUNNABLE — refusing because <reason>` on stderr and emits NO block. This is
 * stated loudly because the failure mode it guards is a refused build being read as
 * a clean one. `burndown-build.test.mjs` pins that a refusal prints nothing
 * resembling a summary.
 *
 * PRECEDENCE IS (date, authority, precedence, PATH) — NEVER list position, so
 * reordering the manifest array cannot move a single count. The last key is the full
 * relative PATH, which is unique by construction; it was the BASENAME, which is not,
 * and two same-basename sources in different directories therefore compared EQUAL and
 * let `Array.sort` stability hand the decision to array position. `_authority: owner`
 * outranks any same-day agent refresh. An agent writing `_authority: owner` on its
 * own measurement is the corruption that field exists to prevent.
 *
 * Exit codes: 0 = block generated / block is current. 1 = block is STALE (--check).
 *             2 = UNRUNNABLE, refused, no block produced.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { isMainModule } from "./lib/entry-point.mjs";

// ── the event library, loaded LAZILY and only for the `event-log` kind ──────
//
// The log's schema, validator and fold live in `hooks/lib/burndown-events.js`,
// which is CommonJS because every hook that produces an event is. IMPORTED rather
// than re-implemented: a second copy of `validateEvent` is how the producer and the
// verifier come to disagree about what a well-formed event is, and the verifier
// would then fold a line the producer would have refused.
//
// LAZY, and that is a HARD REQUIREMENT rather than an optimisation. This file is
// distributed by `sync-tier-aware.mjs` on an explicit guarantee that it carries
// ZERO RELATIVE IMPORTS, and two fixture harnesses (`burndown-quote-hooks`,
// `burndown-trace`) COPY THE BIN ALONE into a temporary `.claude/bin/`. A top-level
// require therefore made every mode of this tool — `--quote` included — die with a
// module-resolution error in any tree that has the generator and not the hooks.
// Requiring it only where a manifest declares `event-log` restores that guarantee
// for every path that does not fold a log, and makes the dependency's absence a
// TYPED refusal rather than a loader stack trace.
const requireCjs = createRequire(import.meta.url);

/**
 * The one append sink, MIRRORED rather than imported.
 *
 * It has to be readable without the library, because the `anchor_roots` self-input
 * floor must know the log's path even for a `forest-ledger` manifest in a repo that
 * also carries a log — a conditional floor is one that silently drops exactly where
 * the tautology it prevents becomes reachable. Drift is closed by ASSERTING the
 * mirror against the library whenever the library is loadable (see `eventsLib`),
 * which is the same discipline `burndown-events.js::OWNER_STATUSES` uses in the
 * other direction against this file's `ASSIGNABLE`.
 */
const EVENTS_REL = "burndown/events.jsonl";

const EVENTS_LIB_REL = ".claude/hooks/lib/burndown-events.js";

/** Load the library, or return null. Never refuses — the caller decides what absence means. */
function tryEventsLib() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rel = path.join(here, "..", "hooks", "lib", "burndown-events.js");
  try {
    return requireCjs(rel);
  } catch {
    return null;
  }
}

/**
 * Assert the mirror against the library WHENEVER THE LIBRARY IS LOADABLE.
 *
 * Separate from `eventsLib()` because that one runs only under `event-log`, while the
 * mirrored constant is consumed by the `anchor_roots` self-input floor under BOTH
 * kinds — so keying the drift check on the fold left it unreachable on exactly the
 * case the mirror was written for. MEASURED before the split: with the library's sink
 * drifted to `evlog/log.jsonl`, a `forest-ledger` manifest declaring
 * `anchor_roots: ["evlog/"]` and every item anchored AT the drifted sink printed
 * `chain INTACT` — the tautology the floor exists to prevent, reported as a pass.
 *
 * Silent when the library is ABSENT, which is not drift: a tree carrying the bin
 * without the hooks has no producer, so there is no second value to disagree with.
 */
function assertEventsMirror() {
  const lib = tryEventsLib();
  if (!lib) return;
  if (lib.EVENTS_REL !== EVENTS_REL) {
    refuse(
      `the event library declares its append sink as '${safeCell(lib.EVENTS_REL)}' while this generator ` +
        `mirrors '${EVENTS_REL}'. The mirror has DRIFTED, so the self-input floor is guarding a path nothing ` +
        `writes to — and an anchor_root admitting the REAL sink would then pass, letting every row anchor ` +
        `at the log that declares it. Re-align the two rather than picking one.`,
    );
  }
}

let _eventsLib = null;
function eventsLib() {
  if (_eventsLib) return _eventsLib;
  const lib = tryEventsLib();
  if (!lib) {
    // `e.code`/`e.message` are deliberately NOT interpolated: a load-time Error with
    // no `.code` carries a message embedding `__filename`, which would print the
    // operator's absolute tree into CI logs and PR comments — the one disclosure this
    // file is careful never to make.
    refuse(
      `a manifest declares tracker kind 'event-log', but the event library '${EVENTS_LIB_REL}' could not ` +
        `be loaded. The fold reads the log through the SAME validator the producer writes it with; without ` +
        `it this tool would have to re-implement that validator, and the two copies would disagree about ` +
        `what a well-formed event is. Install the hooks tree, or declare tracker kind 'forest-ledger'.`,
    );
  }
  // PRESENT is not COMPATIBLE. A stale library that carries the constant but not the
  // fold escaped as a plain TypeError, which is not an `Unrunnable` — so it rethrew,
  // printed a stack trace carrying the operator's ABSOLUTE path, and exited 1, the
  // code this file's own ladder reserves for STALE. A crash misreported as staleness,
  // which is the exact defect the `tracker.path` shape check a few hundred lines down
  // records having closed. The contract is checked, not assumed.
  // `verifyAuthorityBindings` + `makeRosterSignerResolver` are named here for the same
  // reason the two above are: this generator CALLS them on the `event-log` path, and a
  // hooks tree from before the authority binding existed would load, pass a check that
  // named only the fold, and then fold a log whose `owner` claims nothing ever bound —
  // the silent downgrade every other check on this path refuses.
  // `statusKey` joins the contract for the SAME reason: the acceptance-landing join
  // compares a board status against an activation's through it, and a hooks tree
  // without it would throw mid-run and exit 1 — the code reserved for STALE.
  for (const fn of ["foldEvents", "validateEvent", "verifyAuthorityBindings", "makeRosterSignerResolver", "statusKey"]) {
    if (typeof lib[fn] !== "function") {
      refuse(
        `the event library '${EVENTS_LIB_REL}' loaded but exports no '${fn}' function. It is present and ` +
          `INCOMPATIBLE, which is a different fact from absent: the fold would throw mid-run and exit 1, ` +
          `the code reserved for STALE. Update the hooks tree to match this generator.`,
      );
    }
  }
  assertEventsMirror();
  _eventsLib = lib;
  return lib;
}

/**
 * DOES THIS `accepted_by` NAME AN AGENT? DELEGATED, never re-implemented here.
 *
 * MEASURED as a defect before this function existed: this file asked that question at
 * TWO sites and the library at a THIRD, and no two agreed. `migration_baseline` compared
 * CASE-SENSITIVELY against `"agent"`/`"assistant"`; the acceptance channel tested
 * `/\bagent\b/i`; `burndown-events.js` matched its four-word vocabulary EXACTLY. Measured
 * both ways: `"assistant"` was refused by the log validator and ACCEPTED by the
 * acceptance channel, and `"the agent"` was ACCEPTED by `migration_baseline` and refused
 * by the acceptance channel. Neither subsumed the other, and a comment on the newest of
 * the three asserted they held "the same standard" — a `zero-tolerance.md` Rule 3e claim
 * about a code surface, false in both directions. Both sites now call the library's ONE
 * predicate, which is the same delegation `eligibility.js::isEligibleSigner` records.
 *
 * IT REFUSES RATHER THAN FALLING BACK. This file is distributed on a ZERO RELATIVE
 * IMPORTS guarantee and the library is loaded lazily, so it CAN be absent — two fixture
 * harnesses copy this bin alone into a temporary tree. A local copy of the predicate for
 * that case would be the fourth copy, recreating exactly the drift this closes, and
 * answering `false` would be worse still: the question would silently become "no" for
 * every value. So absence is INDETERMINATE and refuses. The blast radius is narrow and
 * named: it fires only on a manifest that declares `inventory.migration_baseline` in a
 * tree with no hooks — the acceptance channel's own caller has already refused a
 * non-`event-log` tracker by the time it asks, so the library is loaded there.
 */
function isAgentAcceptor(value) {
  const lib = tryEventsLib();
  if (!lib || typeof lib.isAgentAcceptor !== "function") {
    refuse(
      `deciding whether an 'accepted_by' names an AGENT needs the event library ` +
        `'${EVENTS_LIB_REL}', which could not be loaded (or is present and INCOMPATIBLE, which is a ` +
        `different fact from absent). The predicate lives there so this tool and the log's own ` +
        `validator refuse the SAME values; a local copy is how two gates come to disagree about what ` +
        `they both refuse. No predicate, no verdict — which is INDETERMINATE, never a pass. Install ` +
        `the hooks tree.`,
    );
  }
  return lib.isAgentAcceptor(value);
}

const SIGNED_LOG_LIB_REL = ".claude/hooks/lib/signed-log.js";

/**
 * The append-only predicate, loaded LAZILY on exactly the same terms as `eventsLib`
 * above and for exactly the same reason: this file is distributed on a ZERO RELATIVE
 * IMPORTS guarantee and two fixture harnesses copy the bin alone into a temporary
 * `.claude/bin/`. A top-level import would break every mode of this tool in a tree
 * that has the generator and not the hooks.
 *
 * Only the `event-log` kind reaches it, so a `forest-ledger` repo never needs the file.
 */
let _signedLogLib = null;
function signedLogLib() {
  if (_signedLogLib) return _signedLogLib;
  let lib = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Bound to its own line, mirroring `tryEventsLib`, so a fixture that relocates the
    // bin can REBASE this resolution the same way it rebases the event library's.
    const rel = path.join(here, "..", "hooks", "lib", "signed-log.js");
    lib = requireCjs(rel);
  } catch {
    lib = null;
  }
  if (!lib) {
    // As in `eventsLib`: the caught error is NOT interpolated. A load-time Error with
    // no `.code` embeds `__filename`, which would print the operator's absolute tree
    // into CI logs and PR comments.
    refuse(
      `a manifest declares tracker kind 'event-log', but the append-only library ` +
        `'${SIGNED_LOG_LIB_REL}' could not be loaded. An append-only log is held to prefix ` +
        `preservation — "has anything already COMMITTED changed?" — which this tool will not ` +
        `re-implement: a second copy of that predicate is how the gate and the producer come to ` +
        `disagree about what tampering is. Install the hooks tree, or declare 'forest-ledger'.`,
    );
  }
  // PRESENT is not COMPATIBLE — the same distinction `eventsLib` records. A stale
  // library missing the predicate would throw a plain TypeError, which is not an
  // `Unrunnable`, so it would exit 1 (the code reserved for STALE) with a stack trace
  // carrying the operator's absolute path. Checked, not assumed.
  // Every primitive this generator CALLS is named, not just the first one. A library
  // carrying `verifyAppendOnlyPrefix` but not `verifyLogSignatures` is a tree from
  // before the read gate existed, and under a check that named only the prefix
  // predicate it would load, pass, and then fold an UNVERIFIED log — the silent
  // downgrade this whole file refuses everywhere else.
  for (const fn of [
    "verifyAppendOnlyPrefix",
    "loadSuitePolicy",
    "verifyLogSignatures",
    "verifyChain",
    "verifyClosedGenerationAppends",
  ]) {
    if (typeof lib[fn] !== "function") {
      refuse(
        `the append-only library '${SIGNED_LOG_LIB_REL}' loaded but exports no ` +
          `'${fn}' function. It is present and INCOMPATIBLE, which is a different ` +
          `fact from absent. Update the hooks tree to match this generator.`,
      );
    }
  }
  // THE GUARD STOPPED ONE LIBRARY SHORT, and the gap was reachable: a CURRENT
  // `signed-log.js` beside a STALE `coc-sign.js` passes every check above and then
  // throws a plain `TypeError` out of `verifyLogSignatures` — because `signed-log`
  // destructures `createVerifyHomedir`/`destroyVerifyHomedir` at load time, which
  // yields `undefined` rather than failing, and the call is made 500 lines later.
  // A TypeError is not an `Unrunnable`, so it rethrew, printed a stack trace
  // carrying the operator's ABSOLUTE path, and exited 1 — the code this file's own
  // ladder reserves for STALE. Verbatim the failure the guard exists to prevent,
  // one dependency further down. `signed-log.js` is not the leaf; `coc-sign.js` is.
  assertCocSignCompatible();
  _signedLogLib = lib;
  return lib;
}

const COC_SIGN_LIB_REL = ".claude/hooks/lib/coc-sign.js";

/**
 * The TRANSITIVE half of the compatibility contract.
 *
 * `signed-log.js` calls into `coc-sign.js` for every primitive that actually
 * touches key material: `canonicalSerialize` (the signed byte scope), `verify`
 * (the suite-directed check), and the shared verify-homedir lifecycle. Checked
 * here rather than inside `signed-log.js` for the same reason the direct check
 * lives here: this generator is the process that must not die with a stack trace,
 * and a library cannot make a promise about the module that loaded it.
 */
function assertCocSignCompatible() {
  let lib = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Bound to its own line so the fixture mutation harness can REBASE this
    // resolution exactly as it rebases the other two lazy requires.
    const rel = path.join(here, "..", "hooks", "lib", "coc-sign.js");
    lib = requireCjs(rel);
  } catch {
    lib = null;
  }
  if (!lib) {
    // The caught error is NOT interpolated: a load-time Error with no `.code`
    // embeds `__filename`, printing the operator's absolute tree into CI logs.
    refuse(
      `a manifest declares tracker kind 'event-log', but the signing library ` +
        `'${COC_SIGN_LIB_REL}' could not be loaded. '${SIGNED_LOG_LIB_REL}' verifies every record ` +
        `through it, so without it NO signature in the log can be checked — which is INDETERMINATE, ` +
        `never a pass. Install the hooks tree, or declare tracker kind 'forest-ledger'.`,
    );
  }
  for (const fn of ["canonicalSerialize", "verify", "createVerifyHomedir", "destroyVerifyHomedir"]) {
    if (typeof lib[fn] !== "function") {
      refuse(
        `the signing library '${COC_SIGN_LIB_REL}' loaded but exports no '${fn}' function. It is ` +
          `present and INCOMPATIBLE, which is a different fact from absent: '${SIGNED_LOG_LIB_REL}' ` +
          `destructures it at load time — which yields undefined rather than failing — so the read ` +
          `gate would throw a bare TypeError mid-verify and exit 1, the code reserved for STALE. ` +
          `Update the hooks tree to match this generator.`,
      );
    }
  }
}

// ── the closed vocabulary ───────────────────────────────────────────────────
// Carried INSIDE the emitted block too, so a reader never has to infer what a
// column means. A status outside this set is a refusal, not a silent bucket.
const ASSIGNABLE = Object.freeze([
  "Signed off",
  "Built-not-walked",
  "In progress",
  "Not started",
  "Blocked on you",
]);
const DERIVED = "Open"; // total − Signed off. Never assignable.

// Each of these named at least two different buckets across prior reports, which
// is exactly how the denominator moved without anyone noticing. They are refused
// as status values so the ambiguity cannot re-enter through a source file.
const BLOCKED_LABELS = Object.freeze(["done", "complete", "closed", "finished", "remaining"]);

// ── TWO POPULATIONS, SEPARATE DENOMINATORS ──────────────────────────────────
//
// THE DEFECT THIS REPLACES: one `total` over two populations. The moment projected
// items entered that single denominator, TWO figures broke at once, and the second
// was worse than the staleness the projected class was built to fix.
//
//   1. COMPLETION BECAME UNREACHABLE BY CONSTRUCTION. MUST-4 says complete means
//      `Signed off` equals TOTAL. A projected item is structurally barred from
//      `Signed off` (that is the guardrail, and it stays). So with 221 projected
//      items inside `total`, `Signed off` could NEVER equal it — the register could
//      not be reported complete no matter what the owner accepted.
//   2. THE ADJUDICATION BUCKETS ACQUIRED MEMBERS NOBODY ADJUDICATED. Every one of
//      the five names a position on an OWNER-ACCEPTANCE journey: `Not started` is
//      "accepted into the register, no work begun"; `Built-not-walked` is "not yet
//      walked through with the owner"; `Blocked on you` is "waiting on the owner".
//      A projection of an external registry occupies NONE of them. That is why no
//      honest target existed for `status_derivation.map` — not because the closed
//      vocabulary was missing a value, but because the AXIS was wrong.
//
// The fix is separate denominators, NOT a new status value. The vocabulary stays
// closed; what changes is which population each count is a fraction OF.
//
// THREE DENOMINATORS, each RENDERED as its own labelled column so no reader ever has
// to infer which one a figure is against (`burndown-integrity.md` MUST-2 gets SHARPER
// with two populations in one table, not looser):
//
//   `board`         every item, both classes. A CENSUS. It is never a completion
//                   denominator and no adjudication bucket binds it.
//   `adjudicated`   items some person declared and adjudicated. THE COMPLETION
//                   DENOMINATOR: `Signed off` equals `adjudicated` is complete.
//   `openBoth`      open items across both populations, which is what the growth
//                   split partitions.
//
// `absentWhenNoAdjudicated` is the fourth field and it is not decoration. On a row
// whose adjudicated population is EMPTY — a page carrying only projected items — the
// six adjudication columns render `—` and emit NO TOKEN. They do NOT render `0`,
// because `0 In progress` is a CLAIM that none of them are in progress, and the truth
// is that the question does not apply to a projection at all. A count that cannot be
// asked is not a count of zero.
const COLUMNS = Object.freeze([
  ["board", "board", "board", false],
  ["adjudicated", "adjudicated", "board", false],
  ["signedOff", "Signed off", "adjudicated", true],
  ["builtNotWalked", "Built-not-walked", "adjudicated", true],
  ["inProgress", "In progress", "adjudicated", true],
  ["notStarted", "Not started", "adjudicated", true],
  ["blockedOnYou", "Blocked on you", "adjudicated", true],
  ["open", "Open", "adjudicated", true],
  ["projected", "projected", "board", false],
  ["openBoth", "Open: both populations", "board", false],
  ["openFromRegister", "Open: from original register", "openBoth", false],
  ["openArrivedSince", "Open: arrived since", "openBoth", false],
]);
/** The cell rendered in place of a count the row cannot be asked for. */
const ABSENT_CELL = "—";

const STATUS_KEY = Object.freeze({
  "Signed off": "signedOff",
  "Built-not-walked": "builtNotWalked",
  "In progress": "inProgress",
  "Not started": "notStarted",
  "Blocked on you": "blockedOnYou",
});

const BEGIN = "<!-- BURNDOWN:BEGIN generated by .claude/bin/burndown-build.mjs — DO NOT EDIT BY HAND -->";
const END = "<!-- BURNDOWN:END -->";
const BINDING_CLAUSE =
  "These are the only counts. Any figure quoted anywhere is this block verbatim, or it is wrong.";

// ── provenance tokens — what makes a count TAMPER-EVIDENT ───────────────────
//
// THE ROOT CAUSE. A count is a DERIVED value anyone can re-derive, and a
// re-derivation carries no evidence of which population it chose. Every remedy
// short of this one makes recomputation DISCOURAGED; none makes it DETECTABLE.
// A token derived from the count's own content closes that: change the value,
// the bucket, the denominator, or the sources, and the token stops validating.
//
// NO KEY, AND THAT IS DELIBERATE. The threat model is CARELESS recomputation —
// an agent silently picking a different population — not an adversary. A content
// digest is fully sufficient for that, and it has no custody problem: anyone
// holding the block can verify it with nothing but the block. Deliberately
// re-running the hash to forge a token is a different act, and not one anyone
// does by accident.
const TOKEN_LEN = 6;
function tokenFor(bucket, denominator, value, sourcesDigest) {
  return crypto
    .createHash("sha256")
    .update(`${bucket}|${denominator}|${value}|${sourcesDigest}`)
    .digest("hex")
    .slice(0, TOKEN_LEN);
}
const TOKEN_RX = new RegExp(`(\\d+)\\u27E8([0-9a-f]{${TOKEN_LEN}})\\u27E9`, "g");
// BUG-2: the ASCII-only `\d` above let FULLWIDTH (U+FF10-19) and ARABIC-INDIC
// (U+0660-69) digits slip past the scanner entirely — the generator reported
// "no tokenised counts found" and the hook read that as clean. `\p{Nd}` with the
// `u` flag SEES them; the verifier then REFUSES them explicitly rather than
// silently skipping. Seeing-then-refusing and not-seeing are opposite outcomes
// that were indistinguishable in the output.
const TOKEN_SCAN_RX = new RegExp(`(\\p{Nd}+)\\u27E8([0-9a-f]{${TOKEN_LEN}})\\u27E9`, "gu");
const BLOCK_REGION_RX = /<!-- BURNDOWN:BEGIN[\s\S]*?<!-- BURNDOWN:END -->/g;
function renderCount(value, token) {
  return `${value}⟨${token}⟩`;
}

// ── refusal ─────────────────────────────────────────────────────────────────
class Unrunnable extends Error {}
function refuse(reason) {
  throw new Unrunnable(reason);
}

// ── git ─────────────────────────────────────────────────────────────────────
//
// THE ENVELOPE, AND WHY IT ARRIVED LATE. Every `git` here used to be the LITERAL
// string (PATH-resolved) with NO `env:`, so the child inherited the ambient
// environment. `GIT_DIR` OUTRANKS repository discovery and neither `cwd:` nor
// `-C` pins which repository git resolves — both only choose a DIRECTORY. So one
// ambient variable re-points every query in this file at an attacker-controlled
// repository, and git answers from THAT repo. `git-subprocess-env.js:4-22`
// measures the exact shape:
//
//   $ git -C victim show HEAD:<path>              → victim's own HEAD
//   $ GIT_DIR=evil/.git git -C victim show HEAD:<path>  → the ATTACKER's HEAD
//
// That is not academic here: `rosterKeyResolver` IS `git show HEAD:<roster>`, so
// the working-tree trust-root hole closed in the same change reopened through the
// environment — the attacker's decoy repo supplies a roster carrying their key,
// `expectedFpr` then binds to their own fingerprint, and a new emitter's first
// record is `seq 1 / prev_hash null`, valid by construction, so the chain offers
// no resistance. `assertCommittedAndUnmodified` is steerable the same way: a
// decoy repo can make `ls-files` name the path and `diff --quiet HEAD` succeed
// for a source that is neither committed nor unmodified HERE.
//
// This is `security.md` § Enforcement-Surface Parity in its literal form: the
// envelope was promoted at `signed-log.js` and this INDEPENDENT surface, which
// answers the same questions for the same verdict, never learned it.
//
// ONE SHARED MODULE, NEVER A LOCAL COPY. `git-subprocess-env.js` states the
// reason in its own header — a denylist is permanently one variable behind
// (`GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CONFIG_*`, `GIT_INDEX_FILE`, …), so
// the child gets an EXPLICIT MINIMAL env built there from constants, and two
// copies of that allowlist is exactly the shape that leaves one of them stale.
// Re-implementing it here would trade one parity defect for another.
//
// LAZY, on the same terms as the other three dependencies in this file, so the
// ZERO-RELATIVE-IMPORTS guarantee is kept for module LOAD. It is NOT optional at
// CALL time: absence is a typed refusal, never a silent drop to the ambient
// environment — a security dependency that degrades quietly is not a dependency.
// Dep-closure holds for every real consumer: `sync-tier-aware.mjs::ALWAYS_INCLUDE`
// carries `.claude/hooks/lib/**` and `.claude/bin/burndown-build.mjs` in the SAME
// list, so the envelope arrives wherever this generator does.
const GIT_ENV_LIB_REL = ".claude/hooks/lib/git-subprocess-env.js";

let _gitEnvLib = null;
function gitEnvLib() {
  if (_gitEnvLib) return _gitEnvLib;
  let lib = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Bound to its own line, mirroring the other lazy requires, so a fixture that
    // relocates the bin can REBASE this resolution the same way.
    const rel = path.join(here, "..", "hooks", "lib", "git-subprocess-env.js");
    lib = requireCjs(rel);
  } catch {
    lib = null;
  }
  if (!lib || typeof lib.resolveGitBinary !== "function" || typeof lib.gitEnvForArgs !== "function") {
    // The caught error is NOT interpolated — a load-time Error with no `.code`
    // embeds `__filename` and would print the operator's absolute tree.
    refuse(
      `the git subprocess envelope '${GIT_ENV_LIB_REL}' could not be loaded (or is INCOMPATIBLE, which ` +
        `is a different fact from absent). Every git this tool spawns must run on the resolved binary ` +
        `and an env built from constants: an inherited GIT_DIR outranks repository discovery, so an ` +
        `un-enveloped query is answered by whatever repository the environment names — including the ` +
        `roster read that is this gate's trust root. Running without it would be a SILENT downgrade of ` +
        `a security control, so it refuses instead. Install the hooks tree.`,
    );
  }
  _gitEnvLib = lib;
  return lib;
}

/** The resolved absolute binary. Refuses rather than falling back to PATH. */
function gitBinary() {
  const bin = gitEnvLib().resolveGitBinary();
  if (!bin) {
    refuse(
      `no 'git' binary could be resolved on a TRUSTED path. The literal 'git' is deliberately not used ` +
        `as a fallback: PATH is attacker-influenceable, and a shim named 'git' would answer every ` +
        `question this gate asks. No git, no verdict — which is INDETERMINATE, never a pass.`,
    );
  }
  return bin;
}

function git(repo, args) {
  return execFileSync(gitBinary(), args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnvLib().gitEnvForArgs(args),
  }).trim();
}
function gitOk(repo, args) {
  // NOTE the asymmetry, which is deliberate: the `try` covers only the SPAWN.
  // `gitBinary()` and `gitEnvForArgs` are evaluated OUTSIDE it, so an unresolved
  // binary or a missing envelope raises `Unrunnable` and refuses, instead of
  // being swallowed into a `false` that reads exactly like "git answered no".
  // Collapsing "the check ran and said no" into "the check could not run" is the
  // non-discriminating-instrument shape this whole file is written against.
  const bin = gitBinary();
  const env = gitEnvLib().gitEnvForArgs(args);
  try {
    execFileSync(bin, args, { cwd: repo, stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
}

/**
 * A declared source must be COMMITTED and UNMODIFIED. Both halves matter: an
 * untracked file makes the block unreproducible from the SHA it claims, and a
 * modified one makes the recorded digest a lie about what was counted.
 *
 * `git ls-files -- <p>` and a STRING COMPARE, not `--error-unmatch`: on a
 * case-insensitive filesystem `--error-unmatch` on a wrong-case path reads
 * identically to untracked, so it cannot tell those two apart.
 */
function assertCommittedAndUnmodified(repo, rel) {
  // BUG-3: a SYMLINK defeated both halves of this gate. git stores the LINK TEXT
  // as the blob, so `blobSha` recorded the link while `readJson` followed it and
  // read the TARGET — counts moved 2/5 → 4/3 with a BYTE-IDENTICAL
  // `sources_digest`, a clean `git status`, and no refusal. That falsified the
  // rule's own claim that a block whose sources moved is detectable from the
  // digest alone. Mode `120000` is a symlink; declared sources must be regular
  // files (`100644`/`100755`) so the bytes hashed are the bytes read.
  const staged = git(repo, ["ls-files", "-s", "--", rel]);
  const mode = (staged.match(/^(\d{6})\s/) || [])[1];
  if (mode === "120000") {
    refuse(
      `declared source '${rel}' is a SYMLINK. git hashes the link TEXT while the reader follows it ` +
        `to the TARGET, so the recorded sources_digest would describe something other than what was ` +
        `counted — a source could be swapped with the digest unchanged. Declare the real file.`,
    );
  }
  if (mode && mode !== "100644" && mode !== "100755") {
    refuse(`declared source '${rel}' has git mode ${mode}; declared sources must be regular files`);
  }
  const listed = git(repo, ["ls-files", "--", rel]);
  if (listed !== rel) {
    refuse(
      `declared source '${rel}' is not committed (git ls-files returned ${listed ? `'${listed}'` : "nothing"}). ` +
        `A block generated from an uncommitted source cannot be reproduced from the SHA it records.`,
    );
  }
  if (!gitOk(repo, ["diff", "--quiet", "HEAD", "--", rel])) {
    refuse(
      `declared source '${rel}' has uncommitted modifications against HEAD. ` +
        `The recorded sources_digest would describe committed content that is not what was counted.`,
    );
  }
}

function blobSha(repo, rel) {
  return git(repo, ["rev-parse", `HEAD:${rel}`]);
}

function manifestDirOf(manifestRel) {
  return path.dirname(manifestRel) === "." ? "" : path.dirname(manifestRel);
}

/**
 * ONE shape check for EVERY manifest-declared path, applied at every site.
 *
 * `tracker.path` and `inventory.path` each had a private copy of three clauses while
 * `sources[].path` and `target` had NONE — the `security.md` § Multi-Site Kwarg
 * Plumbing shape, where the fix lands at the primary site and the siblings ship the
 * defect the fix exists to close. `target` was the worst of them: it reaches
 * `path.join(repo, dir, target)` and is WRITTEN under `--write`, so `"../../../tmp/x"`
 * was a write-outside-the-repo primitive. Pre-existing (`230f8aab`, 2026-08-18), and
 * fixed here rather than filed, because it is one clause of the same family.
 *
 * PATHSPEC MAGIC is the fourth clause, and it was named by the original comment as a
 * closed case while the code never checked it. MEASURED: `git ls-files -s -- ':(attr:x'`
 * exits 128 with `fatal: Missing ')' at the end of pathspec magic`, which throws out of
 * `git()` as a non-`Unrunnable` error — Node then prints a stack trace carrying the
 * operator's ABSOLUTE path and exits 1, the code this file's ladder reserves for STALE.
 * A crash misreported as staleness, disclosing the one thing this file never prints.
 */
function assertRepoRelative(manifestRel, label, raw) {
  const p = String(raw == null ? "" : raw)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (
    !p ||
    p.startsWith("/") ||
    p.startsWith(":") ||
    p.split("/").includes("..") ||
    /\s/.test(p) ||
    // NUL and the rest of the C0/DEL control range, which `\s` does NOT cover: it
    // spans 0x09–0x0d and space, leaving 0x00–0x08, 0x0e–0x1f and 0x7f through. Two
    // DIFFERENT crashes were MEASURED from that gap, both exit 1 — the code this
    // file's ladder reserves for STALE — and neither printed the UNRUNNABLE banner:
    //
    //   NUL in a SOURCE path — `execFileSync` refuses the argv entry
    //     (`ERR_INVALID_ARG_VALUE … must be a string without null bytes`), which
    //     throws out of `git()` as a non-`Unrunnable` error and stack-traces.
    //   NUL in TARGET — never reaches git at all; dies later in `node:fs`
    //     `getValidatedPath`, and THAT trace DOES carry the operator's absolute
    //     path, the one thing this file is otherwise careful never to print.
    //
    // The non-NUL controls were measured too and are NOT crashes — a bare 0x01 in a
    // source path refuses cleanly (git's string compare reads it as untracked) and
    // in a target it is silently accepted and written. They are rejected here anyway,
    // at the same choke point, because a control byte in a declared path is a
    // rendering hazard in every refusal message and PR comment downstream of it, and
    // one predicate covering the whole class is what stops the next byte in the range
    // from being a third distinct outcome nobody enumerated.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(p)
  ) {
    refuse(
      // `safeCell` on the LABEL too, not only the value. The file's own stated
      // invariant is that it is applied "wherever a cell is INTERPOLATED into a
      // message", and one caller builds its label AS `source '<entry.path>'` — so a
      // control byte in a declared source path reached stderr RAW through the label
      // even once the value beside it was scrubbed. MEASURED before this line: a NUL
      // in a source path printed the refusal with the byte intact.
      `manifest '${manifestRel}' declares ${safeCell(label)} '${safeCell(raw)}', which is not a repo-relative path. ` +
        `A leading '/' escapes the repo, '..' traverses out of it, ':' is git PATHSPEC MAGIC that makes git ` +
        `exit non-zero (crashing this tool with exit 1, the code reserved for STALE), whitespace is not ` +
        `a path segment this generator will hand to git, and a NUL or control byte crashes it the same ` +
        `way — out of git's argv, or out of node:fs with the operator's absolute path in the trace.`,
    );
  }
  return p;
}

/**
 * The TARGET is resolved through the SAME resolver as the boundary root, and the
 * comparison is between CANONICAL forms — never between lexical strings.
 *
 * WHAT THIS CLOSES, reproduced by execution rather than reasoned about. `target`
 * was turned into an absolute path by `path.join` alone and then WRITTEN THROUGH.
 * `assertRepoRelative` rejects a leading `/`, a `..` SEGMENT, `:` and whitespace —
 * every one of them a property of the STRING. A symlink is a property of the
 * FILESYSTEM, and no amount of string checking can see one. Measured on the
 * pre-fix binary, two poles, both exit 0 with `burndown: wrote block into …`:
 *
 *   LEAF        `REGISTER.md` committed as mode 120000 → a file in /tmp. The
 *               victim's digest moved and the block was spliced into it.
 *   DIR COMPONENT  `target: "docs/REGISTER.md"` with `docs` committed as a symlink
 *               to a directory outside the repo. Same result. `realpathSync`
 *               resolves the WHOLE chain, so one call covers both poles — which is
 *               why this is a resolver, not a leaf special-case.
 *
 * It splices rather than truncates, so the primitive is out-of-tree CONTENT
 * INJECTION, not destruction — and it reports success, which is worse.
 *
 * WHY THE ROOT IS RESOLVED TOO, and not just the candidate. Comparing a realpath'd
 * candidate against a RAW root is the bug wearing a fix's clothes: on macOS
 * `/tmp` IS a symlink and `os.tmpdir()` sits under `/private`, so a raw-root
 * compare would refuse every legitimate write in a temporary checkout while still
 * being unsound in the other direction. `security.md` § Path Containment requires
 * BOTH sides through the SAME resolver; the compliant fixture pole builds its repo
 * in exactly such a directory, so a one-sided resolve reds it.
 *
 * WHY A NON-EXISTENT TARGET IS NOT AN ESCAPE HATCH. First `--write` into a fresh
 * repo has no target yet, and `realpathSync` on a missing leaf throws ENOENT. The
 * PARENT is resolved instead and the basename rejoined — so the directory-component
 * pole is still caught on the very first write, which is precisely when it would
 * otherwise be uncatchable. Anything other than the leaf's own ENOENT (EACCES,
 * ELOOP, ENOTDIR, a missing parent) FAILS CLOSED.
 *
 * WHY A SYMLINK LEAF IS REFUSED EVEN WHEN IT POINTS INSIDE THE REPO. Containment
 * alone would pass it, and the write would still land somewhere other than the path
 * the manifest declares — `--check` would then read the block back out of a
 * different file than the one it names. That is the same "the recorded thing
 * describes something other than what was used" defect `assertCommittedAndUnmodified`
 * refuses mode `120000` for, and it is refused here on the same grounds. `lstat`,
 * never `stat`, because `stat` follows the link it is being asked about.
 *
 * WHAT THIS DOES **NOT** CLOSE, stated because over-claiming it is the failure mode
 * `security.md` § Path Containment names in the same breath as the requirement: the
 * resolve closes the LEXICAL-bypass class and nothing more. It does NOT defeat
 * check-to-use TOCTOU — an attacker who can swap a component for a symlink in the
 * window between this resolve and the `writeFileSync` below still wins, and only
 * fd-based / `O_NOFOLLOW` enforcement AT THE SINK would close that. This is a
 * local-tampering primitive either way: the shipped hook spawns the generator with
 * `["--check-links"]` only, which writes nothing, so reaching the sink at all takes
 * an operator running `--write` in a tree an attacker already controls.
 */
function resolveContainedTarget(repo, manifestRel, targetRel) {
  const lexical = path.join(repo, path.dirname(manifestRel), targetRel);

  let root;
  try {
    root = fs.realpathSync(repo);
  } catch (e) {
    refuse(
      `the repository root could not be resolved to a real path (${e.code || e.message}), so no containment ` +
        `check on target '${safeCell(targetRel)}' is possible. Refusing rather than writing through an ` +
        `unverified boundary.`,
    );
  }

  let leaf = null;
  try {
    leaf = fs.lstatSync(lexical);
  } catch (e) {
    if (e.code !== "ENOENT") {
      refuse(
        `target '${safeCell(targetRel)}' could not be inspected (${e.code || e.message}). A target this tool ` +
          `cannot stat is one it cannot show to be inside the repository, so it is refused rather than written.`,
      );
    }
  }
  if (leaf && leaf.isSymbolicLink()) {
    refuse(
      `target '${safeCell(targetRel)}' is a SYMLINK. This tool WRITES THROUGH the target, so the block ` +
        `would be spliced into the link's destination — a file outside the repository when the link points ` +
        `out of it, and in every case a file other than the one the manifest declares, which --check would ` +
        `then read back from somewhere it never named. Declare the real file.`,
    );
  }

  let resolved;
  try {
    resolved = leaf
      ? fs.realpathSync(lexical)
      : path.join(fs.realpathSync(path.dirname(lexical)), path.basename(lexical));
  } catch (e) {
    refuse(
      `target '${safeCell(targetRel)}' could not be resolved to a real path (${e.code || e.message}). ` +
        `An unresolvable path cannot be shown to be inside the repository; this fails CLOSED.`,
    );
  }

  // `root + path.sep`, never a bare `startsWith(root)`: a sibling directory whose
  // name merely EXTENDS the root's (`/w/repo-evil` against `/w/repo`) passes the
  // bare prefix test and is outside the repository.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    refuse(
      `target '${safeCell(targetRel)}' resolves OUTSIDE the repository. The declared path is repo-relative, ` +
        `but a symlink on it — at the leaf or at any directory component — redirects the write out of the ` +
        `tree. This tool writes through the target, so that is an out-of-repo content-injection primitive, ` +
        `and it is refused.`,
    );
  }
  return resolved;
}

// ── manifest + sources ──────────────────────────────────────────────────────
// `rel` is what appears in refusals, NEVER `abs`: every sibling refusal in this
// file names a repo-relative path, and an absolute one prints the operator's real
// tree into transcripts, PR comments and CI logs. Disclosure, not cosmetics.
function readJson(abs, what, rel) {
  const shown = rel || path.basename(abs);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    refuse(`${what} '${shown}' could not be read: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    refuse(`${what} '${shown}' is not valid JSON: ${e.message}`);
  }
}

function loadManifest(repo, manifestRel) {
  assertCommittedAndUnmodified(repo, manifestRel);
  const m = readJson(path.join(repo, manifestRel), "manifest", manifestRel);
  if (m._schema !== "burndown-manifest/v1") {
    refuse(`manifest '${manifestRel}' declares _schema '${m._schema}', expected 'burndown-manifest/v1'`);
  }
  if (!Array.isArray(m.pages) || m.pages.length === 0) {
    refuse(`manifest '${manifestRel}' declares no pages; a burndown with no pages has no denominator`);
  }
  // `ALL PAGES` is the DERIVED row. A declared page of the same name would put two
  // rows in the table under one name, so a quote naming it would be ambiguous and
  // its token could certify either. Duplicate pages collapse silently in the row
  // Map, dropping a declared page with no diagnostic. Both are refused.
  if (m.pages.some((pg) => typeof pg === "string" && pg.trim().toUpperCase() === "ALL PAGES")) {
    refuse(`manifest '${manifestRel}' declares a page named 'ALL PAGES', which is the reserved DERIVED row`);
  }
  {
    const dupe = m.pages.find((pg, i) => m.pages.indexOf(pg) !== i);
    if (dupe !== undefined) refuse(`manifest '${manifestRel}' declares page '${dupe}' more than once`);
  }
  if (!Array.isArray(m.sources) || m.sources.length === 0) {
    refuse(`manifest '${manifestRel}' declares no sources; nothing to count`);
  }
  if (typeof m.target !== "string" || !m.target) {
    refuse(`manifest '${manifestRel}' declares no target file to emit the block into`);
  }
  return m;
}

// ── the traceability chain ──────────────────────────────────────────────────
//
// WHAT THIS STOPS. A status word with no path back to the ruling that produced
// it. Measured on this tree at authoring time: all 26 register ids resolved in
// ZERO files outside `burndown/register.json`, and the Forest Ledger had ZERO
// rows — so an agent reading `In progress` for `F87-upflow-loop` had nowhere to
// go for the decision behind it, and acted on the bare word. The register's own
// `_id_convention` claimed ids were "kept verbatim so a row stays greppable
// across both surfaces"; that claim was FALSE, and nothing detected it.
//
// HOW IT BROKE, which is what decides the anchor grammar below. The context DID
// once exist: `git show 904b3053^:.session-notes.d/<operator>.md` still carries the
// rulings for eleven of these ids. It was pruned by an ordinary
// `/reconcile-notes` pass (`f07281c6`), because a `.session-notes.d/*` fragment
// is a MEMORY surface and pruning it is what that surface is FOR. The register
// survived; its context did not. So an anchor pointing INTO a reconcilable
// fragment is not a link, it is a link with an expiry date — which is why
// `anchor_roots` gates anchors to DURABLE roots and why `.session-notes.d/`
// is not one of them.
//
// THREE LEGS, `id` the immutable join key:
//   LINK-1  register/growth item id  → a Forest-Ledger row with the same ID
//   LINK-2  that row's `value_anchor` → a RESOLVABLE pointer under a declared
//           durable root, never free prose
//   LINK-3  the context artifact      → carries the id verbatim, so the chain is
//           bidirectional and greppable from either end
//
// SCOPE, stated rather than implied: these run IFF the manifest declares a
// `tracker`. That is NOT an opt-out for this repo — loom declares one, so every
// mode here enforces all three legs. It exists because a BUILD or USE repo may
// carry a burndown and no Forest Ledger at all, and cascading a refusal into a
// repo that has no tracker surface would break a burndown for the absence of a
// file it was never asked to have. `burndown-traceability.md` is what makes
// DECLARING it mandatory wherever a ledger exists; this file cannot see that.
//
// AN ORPHAN LEDGER ROW IS NOT A FINDING. The ledger is broader than the
// burndown — it holds rows that were never register items. LINK-1 runs from the
// ITEMS outward, never from the ledger inward.
const DEFAULT_ANCHOR_ROOTS = Object.freeze(["journal/", "workspaces/", "specs/", "todos/", "briefs/"]);

// The tracker substrates this generator can verify against. See the dispatch in
// `checkLinks` for why `forest-ledger` is retained rather than replaced.
const TRACKER_KINDS = Object.freeze(["event-log", "forest-ledger"]);

// A cell that is decoration, not a pointer. Each of these appeared as a
// `value_anchor` in a drafted row at some point and each reads, to a scanner
// keyed on non-emptiness, exactly like a filled-in link.
const NON_ANCHORS = Object.freeze(["", "-", "—", "–", "n/a", "na", "tbd", "todo", "?", "none", "pending"]);

// LINK-3 is a SUBSTRING test, so a short id matches essentially any prose and the
// leg contributes no discrimination at all: an id of `e` satisfied it against every
// file in the tree (measured). The floor is the one `security.md` § Redactor
// Contract already sets for the identical class — a subject-keyed substring match —
// and for the same stated reason, that 1-7-char ids substring-match benign strings.
//
// It is ALSO the enforcement of a discipline this system previously only documented:
// the bare `F-NN` namespace is REUSED across sessions (`journal/0174` carries an
// F87, F89, F90 and F91 that are different items from the register's), so a bare
// ordinal would have certified a link to another session's decision with every
// mechanical check green. The descriptive suffix is what makes an id an identity,
// and this is the check that requires one.
const MIN_ID_LEN = 8;

/**
 * Parse the Forest-Ledger table WITHOUT touching its layout.
 *
 * By HEADER NAME, never by column position. The `coc-ledger` merge driver parses
 * this same file by header + separator pattern and its own docs say a layout
 * change breaks column detection — so reading positionally here would silently
 * bind this checker to a column order the driver is entitled to reorder. Naming
 * the columns means the two readers agree by construction.
 */
function parseLedger(text, rel) {
  const lines = text.split(/\r?\n/);

  // FENCED CODE IS NOT LEDGER. Without this, the FIRST `| … id … |`-plus-separator
  // pair anywhere in the file wins — including one inside a ```-fence, which renders
  // to a human as a DOCUMENTATION EXAMPLE and was read by this parser as the
  // authoritative table. Measured before the fix: a decoy fence above the real
  // ledger made a register whose only real row was prose report `chain INTACT`.
  // The real ledger was never parsed. A gate whose whole purpose is auditability
  // must read what the reviewer reads.
  const inFence = new Array(lines.length).fill(false);
  {
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
      if (fence === null && m) {
        fence = m[1][0];
        inFence[i] = true;
        continue;
      }
      if (fence !== null) {
        inFence[i] = true;
        if (m && m[1][0] === fence) fence = null;
      }
    }
  }

  // EVERY candidate, not the first. `break`-on-first made the table's POSITION in
  // the file load-bearing and undocumented: an earlier table with an `id` column
  // silently became the ledger. Two candidates is an AMBIGUITY, and this file
  // already refuses ambiguity rather than picking (see `quoteFor`, token
  // collisions, duplicate sources) — guessing hands back a confident verdict for
  // a table the operator did not mean.
  const candidates = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (inFence[i] || !/^\s*\|/.test(lines[i])) continue;
    const cells = splitRow(lines[i]);
    const lower = cells.map((c) => c.toLowerCase());
    if (!lower.includes("id")) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue; // the separator row
    candidates.push({ at: i, cols: lower });
  }
  if (candidates.length === 0) {
    refuse(
      `tracker '${rel}' carries no parseable ledger table (a '| ID | … |' header followed by a separator row) ` +
        `outside a fenced code block. A tracker whose table cannot be found reports NOTHING, which is ` +
        `indistinguishable from a tracker whose every row is present — so it refuses rather than passing.`,
    );
  }
  if (candidates.length > 1) {
    refuse(
      `tracker '${rel}' carries ${candidates.length} candidate ledger tables (header rows at lines ` +
        `${candidates.map((c) => c.at + 1).join(", ")}). Which one is THE ledger is then decided by position, ` +
        `so a table added above the real one would silently become authoritative. Keep exactly one, or move ` +
        `the others inside a fenced code block.`,
    );
  }
  const headerAt = candidates[0].at;
  const cols = candidates[0].cols;
  for (const need of ["id", "value_anchor"]) {
    if (!cols.includes(need)) {
      refuse(
        `tracker '${rel}' has a ledger table with no '${need}' column (found: ${cols.join(", ")}). ` +
          `The traceability chain joins on 'id' and resolves 'value_anchor'; neither is optional.`,
      );
    }
  }
  const idAt = cols.indexOf("id");
  const anchorAt = cols.indexOf("value_anchor");
  const itemAt = cols.indexOf("item");

  const rows = new Map();
  for (let i = headerAt + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) {
      if (line.trim() === "") continue; // a blank line inside the section is not the end
      break;
    }
    const cells = splitRow(line);
    // CELL COUNT MUST MATCH THE HEADER, and a mismatch REFUSES rather than being
    // skipped or truncated. GFM ignores excess cells when RENDERING, so a row with
    // an extra separator looks correct to the reviewer while every column index
    // after the extra one is shifted — the parser then verifies a different cell
    // than the human adjudicated. A short row was previously skipped SILENTLY and
    // resurfaced as `LINK-1 no row with ID`, sending an operator to grep a ledger
    // that plainly contains the row.
    if (cells.length !== cols.length) {
      refuse(
        `tracker '${rel}' line ${i + 1} has ${cells.length} cells but the header declares ${cols.length}. ` +
          `A row whose cell count differs is rendered one way and parsed another, so the value_anchor this ` +
          `checker reads is not the one a reviewer sees. Fix the row (escape a literal pipe as '\\|').`,
      );
    }
    const id = stripDecoration(cells[idAt]);
    if (!id) continue;
    if (rows.has(id)) {
      refuse(
        `tracker '${rel}' declares ledger row '${id}' more than once. ` +
          `Two rows under one ID make the anchor for that id ambiguous, and a checker picking either ` +
          `would certify a context artifact the other row does not name.`,
      );
    }
    rows.set(id, {
      id,
      anchorRaw: cells[anchorAt],
      item: itemAt >= 0 ? stripDecoration(cells[itemAt]) : "",
      line: i + 1,
    });
  }
  return rows;
}

/**
 * Fold the EVENT LOG into the same `Map<id, {id, anchorRaw, item, line}>` the
 * table parser above returns. `line` is the event's 1-based FILE ordinal.
 *
 * WHY THIS AND NOT `parseLedger` FOR THIS REPO. The tracker table is a PROJECTION
 * pretending to be a log — simultaneously the evidence a verified count is computed
 * from and a live mutable work surface, which is what makes a row-keyed 3-way merge
 * of it produce a state that is the fold of NEITHER branch.
 *
 * WHAT THIS SWAP DOES **NOT** BUY, stated because an earlier revision of this comment
 * claimed it and was wrong. It does NOT make the gate's input tamper-proof, and it did
 * NOT close a hand-edit hole the table had: `assertCommittedAndUnmodified` is called
 * ONCE, unconditionally, for BOTH kinds, so the table was already held to exactly the
 * same standard. Nothing here compares the log against a prior revision, so
 * "append-only" is a DISCIPLINE the producer holds and NOT an invariant this gate
 * enforces — a whole-file rewrite keeping `min_rows` distinct ids passes identically.
 * What actually changed is the PARSER and the merge behaviour, not the tamper surface;
 * tamper-evidence still rests on the commit gate plus review of the diff.
 *
 * WHAT DOES NOT CHANGE, and this is the whole reason the swap is cheap: the join is
 * PURE `id` STRING EQUALITY — no ordering, no time — so `checkLinks` below is
 * untouched by the substrate, and `resolveAnchor` is substrate-agnostic and takes
 * ZERO change. Only the producer of `rows` moves.
 *
 * WHAT IS EMPHATICALLY NOT REPLAYED: LINK-2 and LINK-3. Those are LIVE REPO READS
 * at build time (tracked-at-HEAD, git mode ≠ 120000, no uncommitted modifications,
 * the committed bytes carrying the id). They are TIME-VARYING and an append-only log
 * CANNOT express "the artifact I pointed at was deleted" — an event that truthfully
 * recorded an anchor stays true forever while the anchor ROTS. So the fold produces
 * only the `anchorRaw` CELL, exactly as the table parser did, and every leg after it
 * still re-reads the repository. Replaying a leg from the log would convert a rot
 * detector into a tautology.
 *
 * A MALFORMED LINE REFUSES, and the count that decides it is ARITHMETIC rather than
 * a string match on a reason: `foldEvents` increments `considered` for every line
 * that parsed AND validated, so `nonBlank − considered` is exactly the malformed
 * population. The C5 genesis-vs-live fence also reports through `skipped[]`, and
 * those lines ARE well-formed — folding them into the same number would refuse a
 * healthy log the first time a real transition superseded a genesis.
 */
function foldLedgerEvents(text, rel) {
  const { foldEvents, validateEvent } = eventsLib();
  const folded = foldEvents(text);
  const { rows, skipped, considered } = folded;
  const lines = text.split(/\r?\n/);
  const nonBlank = lines.filter((l) => l.trim() !== "").length;

  // Malformed by RE-DERIVATION, so the refusal can name lines and reasons. A skip
  // whose line still parses and validates is the C5 fence, not corruption.
  const malformed = skipped.filter((s) => {
    try {
      return !validateEvent(JSON.parse(lines[s.line - 1])).ok;
    } catch {
      return true;
    }
  });

  // Every message below is bounded through `safeCell`. `validateEvent` interpolates
  // the offending value into its reason BEFORE `MAX_FIELD_CHARS` is reached (the
  // schema/kind/weight/authority clauses return first), so a line whose `schema` is
  // megabytes — or carries ESC (U+001B), which `/\s/` does not match — would otherwise
  // be re-emitted verbatim into CI logs, PR comments and operator terminals. That is
  // the exact class `safeCell` exists for, and it was applied at eight sites in
  // `resolveAnchor` and ZERO on this path.
  const line = (s) => `  line ${s.line}: ${safeCell(s.why)}`;

  // Two independent derivations of the same number. They can only disagree if the
  // fold's own accounting changed under this file — which is a defect, not a log
  // finding, and it refuses rather than picking whichever answer looks healthier.
  // The HITS are printed, not just the tally: an operator who reaches this branch
  // otherwise has two numbers and nothing to look at.
  if (nonBlank - considered !== malformed.length) {
    refuse(
      `event log '${rel}': the fold reports ${considered} considered of ${nonBlank} non-blank line(s) ` +
        `while ${malformed.length} line(s) re-derive as malformed. Two derivations of the same count ` +
        `disagree, so neither can be trusted; 'hooks/lib/burndown-events.js::foldEvents' and this reader ` +
        `no longer agree on what a considered line is.` +
        (skipped.length ? `\nEvery skip the fold reported:\n${skipped.map(line).join("\n")}` : ""),
    );
  }

  if (malformed.length > 0) {
    const shown = malformed.slice(0, 10);
    refuse(
      `event log '${rel}' carries ${malformed.length} unreadable line(s) of ${nonBlank}. An append-only ` +
        `log that folds around its own corruption reports a SMALLER board, not a broken one — "the log ` +
        `folded clean" and "the log had ${malformed.length} unreadable lines" would render identically:\n` +
        shown.map(line).join("\n") +
        (malformed.length > shown.length ? `\n  … and ${malformed.length - shown.length} more` : ""),
    );
  }

  // Reachable ONLY with an empty or all-blank file: a malformed line already refused
  // above, and a C5 skip requires a prior `rows.set` for that item. So the message
  // says the one thing that is true here rather than interpolating a count that is
  // always zero.
  if (rows.size === 0) {
    refuse(
      `event log '${rel}' is EMPTY — it folds to zero items. A tracker that reports nothing is ` +
        `indistinguishable from one whose every row is present, so it refuses rather than passing an ` +
        `empty projection off as a clean board.`,
    );
  }

  // SUPERSESSIONS ARE COUNTED AND REPORTED, never silent. `foldEvents` is last-wins
  // for an `item_id`, where `parseLedger` REFUSED a duplicate row outright — and the
  // difference matters to a REVIEWER, not just to the fold. Redirecting an anchor
  // under the table was an EDIT, so the diff showed the substitution and whoever
  // adjudicated the diff saw it. Under the log it is an APPEND: the diff shows one
  // added line, the superseded line is untouched and still reads correctly, and
  // nothing tells the reviewer which one the gate actually read. Refusing is wrong —
  // supersession is the A4 status-promotion channel and is the POINT of a transition —
  // so the number is surfaced instead, the same way COVERAGE states ABSENT rather
  // than letting absence read as clean.
  //
  // TWO INDEPENDENT DERIVATIONS, and they must agree. The arithmetic one needs no
  // second walk: `considered` counts every valid line, `rows.size` counts distinct
  // winners, and the C5 skips are valid lines that did not win, so
  // `considered − rows.size − c5` is exactly the supersession population. The fold
  // now ALSO returns the HITS — `superseded[]`, each row naming the item and both
  // line ordinals — which is what a reviewer needs and what a tally cannot give
  // (`instrument-discipline.md` MUST-3(b)).
  //
  // Keeping both and cross-checking them is deliberate. A count with no hits sends an
  // operator to grep the log; hits with no independent derivation can drift silently
  // if the fold's accounting changes underneath this reader. They can only disagree
  // if one of those two things happened — a defect, not a log finding — so it refuses
  // rather than picking whichever answer looks healthier, exactly as the
  // `nonBlank − considered` check above does.
  const supersededCount = considered - rows.size - (skipped.length - malformed.length);
  const supersededHits = Array.isArray(folded.superseded) ? folded.superseded : null;
  if (supersededHits === null) {
    refuse(
      `event log '${rel}': the fold returned no 'superseded' record. This reader cross-checks the ` +
        `supersession count against the fold's own hits, and an absent record means ` +
        `'hooks/lib/burndown-events.js::foldEvents' no longer reports them — so the count below is ` +
        `unverifiable rather than merely unaccompanied.`,
    );
  }
  if (supersededHits.length !== supersededCount) {
    refuse(
      `event log '${rel}': the fold recorded ${supersededHits.length} supersession(s) while this ` +
        `reader derives ${supersededCount} arithmetically. Two derivations of the same number ` +
        `disagree, so neither can be trusted.` +
        (supersededHits.length
          ? `\nEvery supersession the fold reported:\n` +
            supersededHits
              .map((s) => `  ${safeCell(s.item_id)}: line ${s.superseded_line} → line ${s.superseded_by_line}`)
              .join("\n")
          : ""),
    );
  }
  // THE RETIRED POPULATION, carried out rather than derived here. A retraction
  // retires an item IN PLACE — `rows` still holds it — so nothing downstream can tell
  // a retired item from a live one by looking at the row count, and a reader that
  // wanted to would be re-implementing the fold's own accounting. Absent is a
  // REFUSAL rather than an empty default: an empty array read as "nothing retired"
  // is the silent-fallback shape (`zero-tolerance.md` Rule 3), and it would render
  // identically to a fold that stopped reporting.
  const retired = Array.isArray(folded.retired) ? folded.retired : null;
  if (retired === null) {
    refuse(
      `event log '${rel}': the fold returned no 'retired' record. A retraction retires an item IN PLACE, ` +
        `so the ROW FLOOR below cannot distinguish a retired item from a live one without it — and an ` +
        `absent record read as "none retired" would report a board with retirements as a board without. ` +
        `'hooks/lib/burndown-events.js' no longer matches this generator.`,
    );
  }
  // PENDING COUNTERSIGNATURES, carried out on the same REFUSE-rather-than-default
  // discipline as `retired` above, and for a sharper reason. A proposal is INERT by
  // construction — it folds to nothing — so an absent record read as "none pending"
  // is INDISTINGUISHABLE from a log with no proposals in it, and the whole point of
  // the mechanism is that an owner's decision sitting un-countersigned must be
  // VISIBLE. An inert record nobody reports is exactly the failure it was built to
  // close, reproduced one layer down.
  const pendingProposals = Array.isArray(folded.pendingProposals) ? folded.pendingProposals : null;
  if (pendingProposals === null) {
    refuse(
      `event log '${rel}': the fold returned no 'pendingProposals' record. A proposal folds to NOTHING ` +
        `by construction, so this reader cannot see one any other way — and an absent record read as ` +
        `"no proposals are pending" renders identically to a log in which an owner's decision is ` +
        `sitting un-countersigned. 'hooks/lib/burndown-events.js' no longer matches this generator.`,
    );
  }
  // `skipped` IS RETURNED, and its absence was a live defect rather than an omission of
  // tidiness. It was destructured above for the malformed-line census and then dropped,
  // so every consumer reading `folded.skipped` got `undefined`. The acceptance anchor's
  // fold-honoured check read exactly that key: correct code handed an always-empty set,
  // which excluded nothing, which meant an ORPHAN activation — one naming a proposal
  // that does not exist, landing no status and moving no cell — still bought a full
  // window of silence from the gate. MEASURED: two logs differing only in what the
  // activation's `activates` names produced BYTE-IDENTICAL verdicts, both `quiet`, where
  // both should have refused.
  return { rows, skipped, superseded: supersededCount, supersededHits, considered, retired, pendingProposals };
}

/**
 * Split a GFM table row on UNESCAPED pipes only.
 *
 * A bare `.split("|")` was the highest-value defeat this parser had. GFM says `\|`
 * inside a cell renders as a literal pipe and does NOT split the cell — so a row
 * reading `| id | o | note \| workspaces/attacker/x.md | journal/real.md | s |`
 * RENDERS with `value_anchor` = `journal/real.md`, which is what a reviewer
 * adjudicates, while the naive split produced an extra cell and handed the checker
 * `workspaces/attacker/x.md` instead. Measured before the fix: exactly that row
 * reported `chain INTACT`, having verified a file the reviewer never saw. Every
 * downstream fence (symlink mode, containment, tracked-compare, LINK-3) passed —
 * because they were all checking the WRONG PATH correctly.
 */
function splitRow(line) {
  const body = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|"; // an ESCAPED pipe is content, not a delimiter
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Backticks, bold and link syntax are TYPOGRAPHY. The anchor binds the PATH, so
// `` `journal/0583-x.md` `` and `journal/0583-x.md` are the same pointer — a
// checker that rejected the rendered form would train people to write bare paths
// into a markdown table, which is the opposite of what the ledger wants.
function stripDecoration(cell) {
  let s = (cell || "").trim();
  s = s.replace(/^\[([^\]]*)\]\([^)]*\)$/, "$1"); // [text](href) → text
  s = s.replace(/^[*_`]+/, "").replace(/[*_`]+$/, "");
  return s.trim();
}

/**
 * Resolve one `value_anchor` cell to a durable, existing, TRACKED context file.
 *
 * TRACKED, not merely present on disk, and that is load-bearing: an untracked
 * file is not durable — it reaches no other operator, survives no clone, and
 * disappears from the next checkout with no diff anyone could have objected to.
 * The declared sources are held to exactly this standard a few functions up; an
 * anchor pointing at a file nobody else can see would be a link only for the
 * agent that wrote it.
 */
/**
 * Bound attacker-controlled cell text before it reaches stderr.
 *
 * Refusals interpolate ledger cells, and that output lands in CI logs, PR comments
 * and operator terminals. A cell is one line and may be megabytes; it may also carry
 * ESC (U+001B), which `/\s/` does not match, so ANSI sequences would be re-emitted
 * verbatim to whatever renders the log. Truncate, and strip C0/C1 control bytes.
 *
 * Escapes are written `\u00XX`, never as literal control bytes in the regex — a
 * literal ESC in this source is invisible in every diff and review that would have
 * to catch a mistake in it.
 */
function safeCell(s) {
  const t = String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F-\u009F]/g, "\uFFFD");
  return t.length > 160 ? `${t.slice(0, 160)}\u2026 (${t.length} chars, truncated)` : t;
}

// The cell used for RESOLUTION is never the sanitized one: sanitizing the value then
// handed to git would corrupt legitimate paths. `safeCell` is applied only where a
// cell is INTERPOLATED into a message. A cell far too long to be a path is refused
// outright rather than passed to `execFileSync`, where it would exceed the argv limit
// and throw out of `git()` uncaught — exit 1, the code this file's ladder reserves for
// STALE, plus a stack trace carrying the operator's absolute path.
const MAX_ANCHOR_CHARS = 4096;

function resolveAnchor(repo, row, roots, rel) {
  const raw = stripDecoration(row.anchorRaw);
  if (raw.length > MAX_ANCHOR_CHARS) {
    return {
      ok: false,
      why: `its value_anchor is ${raw.length} characters long; a path is not. The maximum is ${MAX_ANCHOR_CHARS}.`,
    };
  }
  if (NON_ANCHORS.includes(raw.toLowerCase())) {
    return {
      ok: false,
      why:
        `its value_anchor is ${raw === "" ? "EMPTY" : `'${safeCell(raw)}'`}, which is decoration, not a pointer. ` +
        `Give a path under one of ${roots.join(", ")} — optionally '<path>#<anchor>'.`,
    };
  }
  // Free prose is the failure this exists to name, and it is the one that looks
  // most like a filled-in field. A pointer has no spaces in its path segment.
  const hashAt = raw.lastIndexOf("#");
  const rawPath = hashAt > 0 ? raw.slice(0, hashAt) : raw;
  const fragment = hashAt > 0 ? raw.slice(hashAt + 1) : null;
  // An EMPTY fragment satisfied the check vacuously: `text.includes("")` is always
  // true, so `journal/x.md#` named a section slot that pinned nothing while reading
  // as pinned. Refused rather than treated as absent, because the operator who
  // typed the `#` believed they had anchored something.
  if (fragment !== null && fragment.trim() === "") {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(raw)}' ends in a bare '#'. An empty fragment matches every file vacuously, ` +
        `so it reads as a pinned section while pinning nothing. Name the section, or drop the '#'.`,
    };
  }
  if (/\s/.test(rawPath) || rawPath === "") {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(raw)}' is free prose, not a resolvable pointer. ` +
        `Prose records what someone believed; a path records where the ruling IS.`,
    };
  }
  const p = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/") || p.split("/").includes("..")) {
    return { ok: false, why: `its value_anchor path '${safeCell(p)}' is not a repo-relative path` };
  }
  if (!roots.some((r) => p.startsWith(r))) {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(p)}' is outside every declared durable root (${roots.join(", ")}). ` +
        `A '.session-notes.d/' fragment is the case this refuses by name: it is a MEMORY surface ` +
        `that '/reconcile-notes' is entitled to prune, and pruning it is what removed the context ` +
        `for eleven of this register's ids already.`,
    };
  }
  // A SYMLINK defeats every check above. `git ls-files` reports it as tracked and
  // `startsWith(root)` sees a lexically-contained path, but git stores the LINK
  // TEXT as the blob while `readFileSync` follows it to the TARGET — so an anchor
  // at `workspaces/x.md` symlinked outside the tree would satisfy LINK-2 and
  // LINK-3 against content no reader of this repo has. Same defect BUG-3 closed
  // for declared SOURCES a few hundred lines up, and the same one
  // `security.md` § Path Containment names: the lexical check above is NOT a
  // containment decision, only a shape check.
  const stagedAnchor = git(repo, ["ls-files", "-s", "--", p]);
  const anchorMode = (stagedAnchor.match(/^(\d{6})\s/) || [])[1];
  if (anchorMode === "120000") {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(p)}' is a SYMLINK. git records the link TEXT while the reader follows it ` +
        `to the TARGET, so the chain would be verified against content that is not in this repo. ` +
        `Anchor at the real file.`,
    };
  }
  if (anchorMode && anchorMode !== "100644" && anchorMode !== "100755") {
    return { ok: false, why: `its value_anchor '${safeCell(p)}' has git mode ${anchorMode}; an anchor must be a regular file` };
  }
  // `core.quotePath` is ON by default, so `git ls-files` C-QUOTES any path with a
  // non-ASCII byte — `workspaces/naïve/c.md` comes back as
  // `"workspaces/na\303\257ve/c.md"` and the string compare then asserts a tracked
  // file is untracked. The verdict would depend on the operator's git config, which
  // is not a property of the repository. `-z` plus quotePath=false gives the raw
  // bytes and NUL-terminates them, so no quoting or splitting ambiguity survives.
  const listed = git(repo, ["-c", "core.quotePath=false", "ls-files", "-z", "--", p]).replace(/\0+$/, "");
  if (listed !== p) {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(p)}' is not a tracked file (git ls-files returned ` +
        `${listed ? `'${listed}'` : "nothing"}). An untracked anchor reaches no other operator ` +
        `and does not survive a clone, so it is a link only for whoever wrote it.`,
    };
  }
  // READ THE COMMITTED BYTES, never the working tree — and that single choice is
  // what closes four separate holes at once:
  //
  //   (1) The chain used to be verifiable against UNCOMMITTED content: add the id
  //       to a file, run the build, get INTACT, never commit the file. The block
  //       then records a `generated_from_sha` whose chain does not hold at that SHA.
  //       That is exactly the "recorded digest describes something other than what
  //       was counted" defect BUG-3 closed for declared SOURCES and left open here.
  //   (2) The symlink mode check above reads the INDEX, so a path committed as
  //       `100644` and REPLACED in the worktree by a symlink read as a regular file
  //       and `readFileSync` followed it. Reading the object makes the worktree
  //       irrelevant.
  //   (3) The check-to-use TOCTOU `security.md` § Path Containment names explicitly
  //       as NOT closed by a realpath re-check: the sink here no longer touches the
  //       filesystem, so there is no path to swap between check and use.
  //   (4) A FIFO or device file at a tracked path can no longer hang the read.
  //
  // The earlier `realpathSync` containment pair is GONE rather than kept as
  // belt-and-braces: it guarded a filesystem read that no longer happens, and dead
  // defensive code invites a future reader to restore the read it was protecting.
  let text;
  try {
    text = git(repo, ["show", `HEAD:${p}`]);
  } catch {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(p)}' is tracked but not present in HEAD, so it is staged or uncommitted. ` +
        `A chain verified against bytes that are not committed is a claim about content no other ` +
        `operator has; commit the context artifact first.`,
    };
  }
  // The committed bytes are what was VERIFIED; the worktree bytes are what a human
  // will OPEN. If they differ, the verdict describes a file the reader is not
  // looking at — the same reason the declared sources are held to unmodified.
  if (!gitOk(repo, ["diff", "--quiet", "HEAD", "--", p])) {
    return {
      ok: false,
      why:
        `its value_anchor '${safeCell(p)}' has uncommitted modifications against HEAD. The chain is verified ` +
        `against the COMMITTED bytes, so a verdict here would describe content that differs from what ` +
        `a reader opening that file would see.`,
    };
  }
  if (fragment !== null && !text.includes(fragment)) {
    return {
      ok: false,
      why:
        `its value_anchor names fragment '#${safeCell(fragment)}' but '${safeCell(p)}' does not contain that string. ` +
        `A fragment that resolves nowhere points at the file's silence.`,
    };
  }
  // LINK-3. The back-reference is what makes the chain readable from the CONTEXT
  // end — `git grep -F <id>` has to find the ruling, not just the register.
  if (!text.includes(row.id)) {
    return {
      ok: false,
      why:
        `'${safeCell(p)}' does not carry the id '${row.id}' verbatim, so the chain is one-directional: ` +
        `the ledger points at the context but 'git grep -F ${row.id}' never finds it. ` +
        `LINK-3 requires the back-reference.`,
      leg: "LINK-3",
    };
  }
  return { ok: true, path: p, fragment };
}

// ── the signed-log read gate ────────────────────────────────────────────────

const ROSTER_REL = ".claude/operators.roster.json";

/**
 * Build the `verified_id → key` resolver `signed-log.js::verifyLogSignatures` needs,
 * from this repo's COMMITTED operator roster.
 *
 * A record names its signer by FINGERPRINT (`verified_id`), and the roster is the one
 * artefact binding a fingerprint to key material. Absent or unparseable, NOTHING can
 * attribute a signature, so this returns a typed refusal rather than an empty map: an
 * empty resolver would report every record `unrostered-signer`, which is the right
 * verdict for the wrong reason and points the operator at the records instead of at
 * the missing roster.
 *
 * ── THE TRUST ROOT IS READ FROM `HEAD`, NOT FROM THE WORKING TREE ────────────
 *
 * An earlier revision read the working-tree roster and recorded the resulting hole as
 * a BOUND owned by "the roster write-guards". That disposition was WRONG on both legs
 * and is withdrawn rather than restated:
 *
 *   1. The exploit is end-to-end and needs no privilege this gate does not already
 *      assume: generate a key → add it to the working-tree roster → sign a forged
 *      `burndown-event/v1` record → append it. `classifyRecord` passes, `resolveKey`
 *      returns the attacker's key, `createVerifyHomedir` imports it, and gpg's
 *      `VALIDSIG` names the attacker's OWN fingerprint — so the `expectedFpr` identity
 *      bind, which is the strongest thing in this whole path, is satisfied BY
 *      CONSTRUCTION. `ok:true`. The gate reports the log verified and last-wins folds
 *      the forged status.
 *   2. "The write-guards own it" does not hold. Write-guards are HOOKS, and the
 *      adversary modelled here writes files directly, which no hook observes.
 *
 * And the asymmetry inside this very file is what makes it blocking: the manifest, the
 * tracker table, the inventory and every declared source are ALL held to
 * `assertCommittedAndUnmodified`. The roster — which supplies the KEYS, and is a
 * strictly STRONGER authority than any suite declaration — was the only exemption.
 *
 * WHY `HEAD:` AND NOT `assertCommittedAndUnmodified` + a working-tree read. Both close
 * the exploit; this one is chosen for two reasons stated rather than assumed:
 *
 *   AVAILABILITY. `assertCommittedAndUnmodified` refuses on ANY uncommitted roster
 *   edit, including one unrelated to signing. That is the D3 unrunnability trap that
 *   got the LOG exempted in the first place, re-imported onto a second file: an
 *   operator mid-`/whoami --register` would find an unrelated gate refusing with exit
 *   2. Reading `HEAD:` keeps the gate RUNNABLE and simply declines to trust a key no
 *   reviewer has seen — the failure lands on the one record that needs it, as
 *   `unrostered-signer` (INDETERMINATE), not on the whole build.
 *
 *   NO CHECK-TO-USE WINDOW. `assertCommittedAndUnmodified` checks git and then reads
 *   the working tree — two different reads of two different objects, with a TOCTOU
 *   window between them and a symlink class it has to special-case (its own BUG-3).
 *   `git cat-file` returns the reviewed bytes THEMSELVES: there is no second read to
 *   race, and a symlinked roster cannot mislead it because git hands back the blob
 *   this repo's history actually contains.
 *
 * The D3 argument that exempts the LOG is deliberately NOT reused here and does not
 * transfer: a `PostToolUse` producer appends to the log on EVERY transition, so
 * committed-and-unmodified would make that gate unrunnable during the work it exists
 * to observe. The roster is not append-per-hook — it changes on operator
 * registration, which is a reviewed PR.
 */
function readCommittedRoster(repo) {
  let raw;
  try {
    // Read the BLOB, not the path. `git show HEAD:<rel>` resolves through the tree
    // git holds, so a working-tree edit, a symlink, or a mid-run swap cannot change
    // what comes back.
    raw = git(repo, ["show", `HEAD:${ROSTER_REL}`]);
  } catch (e) {
    refuse(
      `signature verification is INDETERMINATE: the operator roster '${ROSTER_REL}' could not be read ` +
        `at HEAD (${e.code || "git show failed"}). A record names its signer by fingerprint and the ` +
        `roster is the only thing that maps a fingerprint to key material, so with no COMMITTED roster ` +
        `NO signature in the log can be checked. The roster is read from HEAD rather than the working ` +
        `tree because a working-tree roster is a trust root the attacker can write: adding a key there ` +
        `makes every record signed by it verify, identity bind included. "Could not verify" is reported ` +
        `as a refusal, never as a pass — commit the roster.`,
    );
  }
  let roster;
  try {
    roster = JSON.parse(raw);
  } catch (e) {
    refuse(
      `signature verification is INDETERMINATE: the operator roster '${ROSTER_REL}' is not valid JSON ` +
        `at HEAD: ${e.message}`,
    );
  }
  // SHAPE-CHECKED, mirroring `burndown-events.js::readCommittedRoster`. A HEAD roster
  // that parses to the literal `null` would otherwise be handed to
  // `makeRosterSignerResolver({ roster })`, whose `!== null` guard would decline it and
  // fall through to a SECOND, independent `git show HEAD:` — the exact double-read the
  // one-read invariant below exists to prevent. Fail-closed in outcome either way; the
  // point is that the invariant is structural rather than incidental.
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) {
    refuse(
      `signature verification is INDETERMINATE: the operator roster '${ROSTER_REL}' at HEAD parses, but ` +
        `not to a JSON object. Nothing can map a fingerprint to key material or to a role.`,
    );
  }
  return roster;
}

/**
 * Build the `verified_id → key` resolver from an ALREADY-READ committed roster.
 *
 * Split from the read (`readCommittedRoster` above) when the AUTHORITY resolver
 * arrived, so the two projections of the roster — key material and ROLE — come from
 * ONE `git show` and ONE parse. Two independent reads of the same trust root would
 * have a window between them in which the answers could differ, which is precisely
 * the check-to-use shape reading from `HEAD:` was chosen to avoid.
 */
function rosterKeyResolver(roster) {
  const byFpr = new Map();
  for (const [pid, person] of Object.entries((roster && roster.persons) || {})) {
    for (const k of (person && person.keys) || []) {
      // `type` is as REQUIRED as the other two. `signed-log.js` matches it against the
      // generation's keyType and treats ABSENT as a mismatch — correctly, since a key
      // whose type nobody declared cannot be shown to be the type the generation needs.
      // Resolving such an entry anyway hard-refuses every record by that signer with
      // "carries a undefined key", which is true and tells the operator nothing to do.
      // Skipping it here reports the roster gap as `unrostered-signer` instead: the
      // signer has no usable key, which is what an entry missing half its declaration is.
      // NON-EMPTY, matching `burndown-events.js::signerIndex`. Without it an entry
      // carrying `fingerprint: ""` is admitted under the key `""` here and REJECTED
      // there, so the two indexes over one roster disagree — and a comment in that
      // file asserts they use the same predicate. The claim is made true rather than
      // softened.
      if (!k || typeof k.fingerprint !== "string" || !k.fingerprint) continue;
      if (typeof k.pubkey !== "string" || typeof k.type !== "string") continue;
      // FIRST WINS, deliberately. A duplicate fingerprint across two persons is a
      // roster defect the roster's own schema validator owns; silently preferring the
      // later one here would let a roster edit re-point an existing signer's key
      // without the diff reading as a key change.
      if (!byFpr.has(k.fingerprint)) byFpr.set(k.fingerprint, { pubkey: k.pubkey, keyType: k.type, fingerprint: k.fingerprint, person_id: pid });
    }
  }
  return (verifiedId) => byFpr.get(verifiedId) || null;
}

/**
 * THE READ GATE (component 8 + the verification half of component 10).
 *
 * `verifyAppendOnlyPrefix` above answers "has anything already COMMITTED changed?".
 * It is strictly stronger than signature checking for DELETION and REORDERING, and
 * it is BLIND to two things, both of which are live:
 *
 *   1. anything BEYOND the committed prefix. Appends are permitted by construction,
 *      so an appended-but-uncommitted record is unexamined — and MEASURED on this
 *      repo before this gate existed, a record copied from the log with its `sig`
 *      replaced by the literal text `TOTALLY-FORGED-NOT-A-SIGNATURE` was accepted at
 *      exit 0 and WON the last-wins fold, flipping a live item to "Signed off".
 *   2. the committed prefix's own provenance. Prefix preservation compares the file
 *      to git; it never asks whether the bytes git holds were signed by anyone.
 *
 * So the two are ADDITIVE. This runs after the prefix check and after the fold has
 * been COMPUTED, but before any verdict reads the folded rows — see the call site for
 * why that ordering is deliberate rather than a compromise. Nothing downstream of it
 * rests on a record whose signature was never checked.
 *
 * THREE checks run here, not two, and the third exists because the first two have a
 * shared blind spot rather than because it is thorough: a record stamped with a
 * CLOSED generation's schema and appended beyond the committed prefix is permitted by
 * the prefix predicate (by design) and skipped by the chain (which is generation-
 * scoped), so it joined no chain, got no `seq`, and was invisible to fork detection
 * while every gate reported clean. `verifyClosedGenerationAppends` is what sees it.
 *
 * THE CHAIN half is generation-scoped and that is load-bearing rather than a
 * convenience: generation 0's 534 records predate `seq`/`prev_hash` entirely, so
 * running the chain over them would report 534 `missing-seq` findings against a log
 * that is exactly as its producer wrote it (MEASURED — `verifyChain(text,
 * "burndown-event/v1")` returns 534 findings). Scoping it to the CURRENT generation
 * means gen-0 records neither participate nor need re-emitting, which is the property
 * that let component 7 close without rewriting history.
 *
 * A CONSEQUENCE THAT MUST NOT BE OVER-READ: with zero generation-1 records on disk
 * today the chain check examines ZERO records here and cannot fail. It is NOT
 * vacuous — it fires on the first v2 append, and
 * `audit-fixtures/burndown-log-verification/`'s
 * `chain-catches-a-committed-middle-record-deletion` arm pins that it reds on a
 * deleted middle record — but a green from it TODAY is evidence about the
 * generation-1 population only, which is currently empty. The signature half is what
 * carries all 534.
 */
function verifySignedLog(repo, manifestRel, trackerRel, text, committedBytes) {
  const lib = signedLogLib();
  const pol = lib.loadSuitePolicy(repo, manifestRel);
  if (!pol.ok) {
    refuse(
      `event log '${trackerRel}': signature verification is INDETERMINATE — ${pol.reason} ` +
        `Without a declared suite nothing can say which algorithm verifies these records, and ` +
        `coc-sign defaults to 'ssh', so guessing would report an entire openpgp log as forged.`,
    );
  }
  // ONE read of the trust surface, TWO projections of it (keys, and — below — ROLES).
  // Reading it twice would open a window in which the key that verified a record and
  // the role that authorised it came from different sources.
  //
  // THE SURFACE IS THE TRUST ROOT WHERE ONE IS COMMITTED, the roster otherwise. This
  // is the fix for a CRITICAL found in review: this function used to read the ROSTER
  // and hand it to BOTH projections, so `readCommittedTrustRoot` was never reached
  // from the read gate at all. The trust root bound `appendEvent` and nothing else —
  // and `appendEvent` is the path an adversary skips by hand-writing a signed record.
  // A demotion recorded in the trust root was therefore unenforceable against exactly
  // the actor it existed to bind: it could loosen the producer and could not tighten
  // the reader.
  //
  // BROKEN REFUSES rather than falling back, for the reason `readCommittedTrustRoot`
  // states: a fallback on corruption is a downgrade an attacker triggers by damaging
  // the surface they cannot forge.
  const events0 = eventsLib();
  const tr = events0.readCommittedTrustRoot(repo, {});
  if (tr.ok !== true && tr.absent !== true) {
    refuse(
      `event log '${trackerRel}': the COMMITTED trust root is present but unusable — ${tr.reason} ` +
        `Falling back to the roster here would be an attacker-triggerable downgrade, so this refuses instead.`,
    );
  }
  // `roster` is still read when the trust root is ABSENT — every repo today, which is
  // what keeps this behaviour-preserving until a trust root is committed.
  const roster = tr.ok === true ? null : readCommittedRoster(repo);
  const resolveKey =
    tr.ok === true ? (verifiedId) => tr.index.get(verifiedId) || null : rosterKeyResolver(roster);
  const sigs = lib.verifyLogSignatures(text, pol.policy, { resolveKey });
  if (!sigs.ok) {
    const shown = sigs.findings.slice(0, 10).map((f) => `  line ${f.line}: [${f.kind}] ${f.why}`).join("\n");
    const more = sigs.findings.length > 10 ? `\n  … and ${sigs.findings.length - 10} more finding(s)` : "";
    refuse(
      `event log '${trackerRel}': ` +
        (sigs.indeterminate
          ? `signature verification could not RUN over ${sigs.findings.length} record(s). The log's ` +
            `integrity is UNKNOWN — this is INDETERMINATE, not clean, and is refused rather than ` +
            `reported as a pass.`
          : `${sigs.findings.length} record(s) FAILED signature verification of ${sigs.checked} checked. ` +
            `An unverified signed log is an unsigned log; the projection is not built from it.`) +
        `\n${shown}${more}`,
    );
  }
  // A CLOSED GENERATION MAY NOT GROW — and this check is NOT redundant with either
  // of its neighbours, which is why it is a third call and not a clause inside one
  // of them. `verifyAppendOnlyPrefix` PERMITS everything past the committed prefix
  // by design, and `verifyChain` below is scoped to the CURRENT generation and
  // `continue`s a differing schema before it counts anything — so a record stamped
  // with a closed generation's schema and appended beyond the prefix was seen by
  // NEITHER, joined no chain, was issued no `seq`, and was invisible to the fork
  // detector while every gate reported clean.
  const closed = lib.verifyClosedGenerationAppends(text, pol.policy, committedBytes);
  if (!closed.ok) {
    const shown = (closed.findings || []).slice(0, 10).map((f) => `  line ${f.line}: [${f.kind}] ${f.why}`).join("\n");
    const more = (closed.findings || []).length > 10 ? `\n  … and ${closed.findings.length - 10} more finding(s)` : "";
    refuse(
      `event log '${trackerRel}': ${closed.reason}. ` +
        `A prior generation stays committed and verifiable and NEVER grows — the manifest says so, the ` +
        `producer enforces it, and until now the read gate did not.` +
        (shown ? `\n${shown}${more}` : ""),
    );
  }
  const chain = lib.verifyChain(text, pol.policy.current.schema);
  if (!chain.ok) {
    const shown = chain.findings.slice(0, 10).map((f) => `  line ${f.line}: [${f.kind}] ${f.why}`).join("\n");
    const more = chain.findings.length > 10 ? `\n  … and ${chain.findings.length - 10} more finding(s)` : "";
    refuse(
      `event log '${trackerRel}': the per-emitter chain is BROKEN across ${chain.findings.length} ` +
        `finding(s) over ${chain.checked} generation-'${pol.policy.current.schema}' record(s). Every ` +
        `surviving record's signature still verifies perfectly after a middle record is deleted, so the ` +
        `chain is the only instrument that sees this.\n${shown}${more}`,
    );
  }
  // ── THE AUTHORITY BINDING (component 12) ────────────────────────────────────
  //
  // RUN LAST, and the ordering is load-bearing rather than tidy. This check reads a
  // record's `verified_id` and asks the roster what ROLE that fingerprint carries — a
  // question that means NOTHING until the signature over those bytes has been verified.
  // Ahead of the signature check it would be adjudicating a self-declared fingerprint
  // against a self-declared authority; behind it, `verified_id` is a fingerprint the
  // record's signature actually attests to.
  //
  // WHAT IT SEES, stated because a green here is easy to over-read: it examines only
  // records CLAIMING a role-bound authority. Every record in this repo's log today
  // declares `authority: "agent"`, so `checked` is 0 and the check currently examines
  // NOTHING — it is not vacuous (it fires on the first `owner` claim, and the
  // `authority-*` fixture arms pin that it reds on an unbacked one), but a green from
  // it TODAY is evidence about the owner-claiming population, which is empty. The
  // `--check-links` AUTHORITY line prints `checked` for exactly that reason.
  const events = eventsLib();
  // THE SAME SURFACE the signatures were verified against — `trustRootIndex` when one
  // is committed, `roster` otherwise. Passing `{ roster }` unconditionally is what made
  // the trust root unreachable from this gate; passing the index the keys came from is
  // what keeps "one read, two projections" true after the split.
  const authz = events.verifyAuthorityBindings(
    text,
    events.makeRosterSignerResolver(repo, tr.ok === true ? { trustRootIndex: tr.index } : { roster }),
  );
  if (!authz.ok) {
    const shown = authz.findings.slice(0, 10).map((f) => `  line ${f.line}: [${f.kind}] ${f.why}`).join("\n");
    const more = authz.findings.length > 10 ? `\n  … and ${authz.findings.length - 10} more finding(s)` : "";
    // BOTH CLAUSES WHEN BOTH HOLD. An all-or-nothing `indeterminate` flag collapses a
    // MIXED set: one decided finding beside nine outages renders as ten records whose
    // signer lacked the authority, nine of which are an unreadable roster — and the
    // operator is sent after an adversary for nine of them. The counts come from the
    // library rather than being re-derived here, so the headline and the per-line
    // `[kind]` tags below cannot disagree.
    const parts = [];
    if (authz.indeterminateCount > 0) {
      parts.push(
        `the authority binding could not be EVALUATED for ${authz.indeterminateCount} record(s). That is ` +
          `INDETERMINATE, not clean, and it is refused rather than reported as a pass — an outage ` +
          `reported as a forgery sends the operator hunting an adversary who is not there.`,
      );
    }
    if (authz.unbackedCount > 0) {
      parts.push(
        `${authz.unbackedCount} record(s) declare an authority the COMMITTED roster does not give their ` +
          `signer. 'authority' is a SELF-DECLARED field inside the signed bytes; the signature proves WHO ` +
          `wrote it, and this is what proves they were entitled to.`,
      );
    }
    refuse(
      `event log '${trackerRel}': of ${authz.checked} record(s) claiming a role-bound authority, ` +
        parts.join(" ALSO: ") +
        `\n${shown}${more}`,
    );
  }
  return {
    verified: sigs.checked,
    chained: chain.checked,
    closedChecked: closed.checked,
    authorityChecked: authz.checked,
    // PER GENERATION, from the verifier, NOT `pol.policy.current.suite`. That scalar
    // was read as "the suite these records verified under" and it never meant that —
    // it is the suite the CURRENT generation ACCEPTS FOR APPENDS. The two coincided
    // while every declared generation shared one suite, so the line rendered a true
    // sentence for the wrong reason and no output of it could have shown the error.
    // The generation-2 roll separated them: 534 generation-0 openpgp records were
    // reported "verified under suite 'ssh-rsa'", a suite none of them was signed with.
    verifiedBySuite: sigs.verifiedBySuite || [],
    currentSuite: pol.policy.current.suite,
  };
}

/**
 * Run all three legs over the resolved item set. Collects EVERY finding before
 * refusing, rather than throwing on the first: an operator backfilling a ledger
 * needs the whole list, and a checker that reports one broken link per run turns
 * a 26-row backfill into 26 build cycles.
 */
function checkLinks(repo, manifestRel, manifest, items) {
  // BEFORE anything reads the mirrored `EVENTS_REL`, and unconditionally across both
  // kinds. See `assertEventsMirror` for the measured tautology this closes.
  assertEventsMirror();
  const t = manifest.tracker;
  if (t === undefined) return null; // no tracker declared — see § SCOPE above
  if (!t || typeof t.path !== "string" || !t.path) {
    refuse(`manifest '${manifestRel}' declares a 'tracker' with no 'path'`);
  }
  // TWO KINDS, and the set GAINS one rather than swapping it.
  //
  //   `event-log`      the committed append-only JSONL. THE kind for a repo that has
  //                    migrated: the gate's input is immutable evidence rather than a
  //                    live work surface, which is the whole point of the split.
  //   `forest-ledger`  the markdown table. RETAINED because this binary ships
  //                    ecosystem-wide via `always_include` while the manifest that
  //                    selects the kind does NOT ship — so a repo carrying a
  //                    hand-maintained ledger and no event log would hard-refuse on
  //                    the first pull. Removing a manifest value a distributed
  //                    binary accepts is a breaking change with no deprecation cycle.
  if (!TRACKER_KINDS.includes(t.kind)) {
    refuse(
      `manifest '${manifestRel}' declares tracker kind '${t.kind}'; expected one of ${TRACKER_KINDS.join(", ")}`,
    );
  }
  const roots =
    t.anchor_roots === undefined
      ? [...DEFAULT_ANCHOR_ROOTS]
      : Array.isArray(t.anchor_roots) && t.anchor_roots.length > 0 && t.anchor_roots.every((r) => typeof r === "string")
        ? t.anchor_roots.map((r) => (r.endsWith("/") ? r : `${r}/`))
        : refuse(
            `manifest '${manifestRel}' declares tracker.anchor_roots ${JSON.stringify(t.anchor_roots)}; ` +
              `expected a non-empty array of path-prefix strings`,
          );

  // A SELF-DECLARED root with no floor made the whole gate vacuous from ONE manifest
  // line, and still printed `chain INTACT`. Two defeats, both one-liners:
  //
  //   "anchor_roots": ["burndown/"]        → every row anchors at the REGISTER, which
  //                                          contains every id by construction, so
  //                                          LINK-2 and LINK-3 pass for every item.
  //   "anchor_roots": [".session-notes.d/"] → re-admits the prunable memory surface
  //                                          this design refuses BY NAME, while the
  //                                          refusal text still claims it is refused.
  //
  // So a root may not admit the burndown's OWN inputs (a chain that verifies itself
  // against its own source is a tautology), may not be the reconcilable fragment
  // subtree, and may not be universal. This is a FLOOR, not an allowlist — a
  // deployment may still declare roots canon never thought of.
  //
  // `EVENTS_REL` is listed UNCONDITIONALLY, not only when `t.path` happens to name
  // it. The event log carries every item id verbatim BY CONSTRUCTION — it is where
  // the ids come from — so an `anchor_roots` of `burndown/` would let every row
  // anchor at the log that declares it and LINK-2/LINK-3 would pass for every item
  // against the gate's own input. That is the identical tautology the `burndown/`
  // register defeat above records, one substrate over, and it must hold even for a
  // `forest-ledger` manifest in a repo that also carries a log.
  //
  // THE INVENTORY IS A SELF-INPUT TOO, and its omission was a live bypass. It
  // enumerates EVERY item id by construction (that is what makes it the coverage
  // denominator), so `"inventory": {"path": "inventory/burndown.json"}` plus
  // `anchor_roots: ["inventory/"]` cleared every clause here and every leg of
  // `resolveAnchor` — `chain INTACT` with LINK-2 and LINK-3 both vacuous. Exactly the
  // register defeat above, via the one input nobody enumerated.
  //
  // EVERY ENTRY IS manifestDir-JOINED, because the joined form is what is actually
  // READ. Comparing the RAW manifest strings let a subdirectory manifest declaring
  // `"path": "../shared/register.json"` read `shared/register.json` while the floor
  // tested `../shared/register.json`, which starts with no root — so
  // `anchor_roots: ["shared/"]` passed the clash test and the tautology re-opened.
  // `EVENTS_REL` is NOT joined: it is a repo-root literal the producer owns, not a
  // manifest-relative declaration.
  const joinRel = (p) => {
    const norm = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!norm) return "";
    return manifestDirOf(manifestRel) ? path.posix.join(manifestDirOf(manifestRel), norm) : norm;
  };
  const selfInputs = [
    ...(Array.isArray(manifest.sources) ? manifest.sources.map((s) => joinRel((s && s.path) || "")) : []),
    joinRel(t.path),
    EVENTS_REL,
    manifestRel,
    joinRel(manifest.target),
    manifest.inventory && typeof manifest.inventory.path === "string" ? joinRel(manifest.inventory.path) : "",
  ].filter(Boolean);
  for (const r of roots) {
    if (r === "/" || r === "./" || r === "." || r.trim() === "/" || r === "") {
      refuse(
        `manifest '${manifestRel}' declares anchor_root '${r}', which admits the whole repository. ` +
          `A root that excludes nothing makes LINK-2 unfalsifiable.`,
      );
    }
    if (/(^|\/)\.session-notes\.d\//.test(r) || r.startsWith(".session-notes")) {
      refuse(
        `manifest '${manifestRel}' declares anchor_root '${r}'. A '.session-notes' surface is MEMORY — ` +
          `'/reconcile-notes' is entitled to prune it, and pruning it is what removed the context for ` +
          `eleven of this register's ids. Declaring it a durable root re-opens the originating failure.`,
      );
    }
    const clash = selfInputs.find((s) => s.startsWith(r));
    if (clash) {
      refuse(
        `manifest '${manifestRel}' declares anchor_root '${r}', which admits the burndown's own input ` +
          `'${clash}'. An item could then anchor at the register, inventory or log that declares it — a ` +
          `chain verifying itself against its own source, which passes for every item by construction.`,
      );
    }
  }

  const manifestDir = manifestDirOf(manifestRel);
  const tPath = assertRepoRelative(manifestRel, "tracker.path", t.path);
  const trackerRel = manifestDir ? path.posix.join(manifestDir, tPath) : tPath;
  // The PRODUCER writes to one hard-coded sink (`burndown-events.js::EVENTS_REL`).
  // If a manifest could point `event-log` at any other path, the verifier would read
  // a file nothing appends to while the producer filled a file nothing reads — and
  // the two would drift apart with every mode still exiting 0 until the item counts
  // diverged far enough to trip LINK-1. Binding them makes producer and verifier
  // agree BY CONSTRUCTION, the same discipline `parseLedger` uses to agree with the
  // merge driver on column names.
  //
  // A CONSEQUENCE WORTH STATING, because the refusal names a path the operator never
  // typed: `trackerRel` is manifestDir-JOINED, so an `event-log` manifest CANNOT live
  // in a subdirectory — `sub/burndown-manifest.json` yields `sub/burndown/events.jsonl`
  // and can never equal the sink. That is correct rather than a limitation: the
  // producer writes to `path.join(repoDir, EVENTS_REL)`, the repo ROOT, so a subdir
  // manifest genuinely cannot reach the real log, and refusing beats reading a phantom.
  if (t.kind === "event-log" && trackerRel !== EVENTS_REL) {
    refuse(
      `manifest '${manifestRel}' declares tracker kind 'event-log' at '${trackerRel}'` +
        (manifestDir ? ` (its declared '${t.path}' joined to the manifest's directory '${manifestDir}')` : "") +
        `, but the one append path writes to '${EVENTS_REL}'. A verifier reading a file no producer writes ` +
        `reports a board that is not the one being worked. An 'event-log' manifest must sit at the repo root.`,
    );
  }
  // The tracker is held to a COMMITTED-EVIDENCE standard: a block whose chain was
  // verified against a working-tree edit is a block whose provenance claim is about
  // content no reader has. WHICH standard depends on the kind, because the two kinds
  // are different KINDS OF FILE and the same question is right for one and wrong for
  // the other.
  //
  // A TABLE is a snapshot: every legitimate change rewrites it, so "is the working
  // tree byte-identical to HEAD?" is exactly right.
  //
  // A LOG is append-only, and for it that question is the WRONG ONE — it takes the
  // gate UNRUNNABLE from the producer's very first append (T1). Every hook that
  // records a transition appends a line; under `assertCommittedAndUnmodified` the
  // next `--check-links` refuses with exit 2 until someone commits, so the gate is
  // unrunnable during exactly the work it exists to observe. An operator who meets
  // that on every append switches the gate off, which is worse than either answer.
  //
  // The right question for a log is "has anything already COMMITTED changed?" —
  // `verifyAppendOnlyPrefix`, which PERMITS appends beyond the committed prefix and
  // forbids precisely what must be forbidden: deletion, reordering, truncation or
  // in-place alteration of anything already committed. That is STRICTLY STRONGER on
  // the classes that matter, not a relaxation — full per-record signature
  // verification does NOT catch a deleted middle record, because every surviving
  // record's signature still verifies perfectly afterwards. It also refuses a
  // symlinked log and a log with no committed content at all, so nothing the old
  // predicate caught is dropped except the append itself.
  let committedBytes = null;
  // Assigned from the append-only predicate's OWN read under `event-log`, and
  // read from disk only on the `forest-ledger` path below. `null` is the marker
  // that no read has happened yet — never a silent empty string, which would fold
  // an empty tracker as though it had been read.
  let text = null;
  if (t.kind === "event-log") {
    // ORDERING IS LOAD-BEARING, and this line is here because omitting it changed a
    // refusal IDENTITY. Under `event-log` the event library is the PRIMARY declared
    // dependency, and its absence has a specific, operator-facing message ("install
    // the hooks tree, or declare tracker kind 'forest-ledger'"). `signedLogLib()`
    // below is a SECOND dependency resolved from the same tree, so in a tree carrying
    // the bin without the hooks BOTH are missing and whichever is touched first wins
    // the refusal. Measured: with the prefix check first, a bin copied without the
    // hooks tree refused for the append-only library instead of the event library,
    // and two mutation cases that mutate the EVENT library reported UNRESOLVED
    // because this refusal fired before their mutation was ever reached. Resolving
    // the primary dependency first keeps the diagnosis pointed at the real cause.
    eventsLib();
    const r = signedLogLib().verifyAppendOnlyPrefix({ repo, rel: trackerRel });
    if (!r.ok) refuse(`event log '${trackerRel}': ${r.reason}`);
    // KEPT, not discarded. `committedBytes` is the boundary between committed
    // evidence and appends, and the closed-generation fence below is the one check
    // that needs it. It was already computed here and thrown away.
    committedBytes = r.committedBytes;
    // THE SAME BYTES, NOT A SECOND READ. `verifyAppendOnlyPrefix` reads the log
    // to judge it and now returns what it read; this used to re-read the file
    // below, so `committedBytes` and the append-only verdict described read #1
    // while everything VERIFIED and FOLDED described read #2.
    //
    // The gap between them is small — milliseconds — and it needs write access at
    // build time, which is the adversary this gate already assumes. What makes it
    // worth closing rather than accepting is WHICH class slips through it: a
    // committed MIDDLE-RECORD DELETION is exactly what prefix preservation
    // uniquely catches, it is invisible to signature verification by construction
    // (every surviving record still verifies perfectly), and the per-emitter
    // chain is vacuous on that axis while the current generation holds no
    // records. So a deletion landing between the two reads was caught by nothing.
    // GUARDED, because `current` is present only on the returns that actually
    // read the file — a symlinked log, a git failure or an unreadable file refuse
    // without bytes. Falling through to the disk read below is correct there:
    // those paths have already refused by the time it matters.
    if (Buffer.isBuffer(r.current)) text = r.current.toString("utf8");
  } else {
    assertCommittedAndUnmodified(repo, trackerRel);
  }

  if (text === null) {
    try {
      text = fs.readFileSync(path.join(repo, trackerRel), "utf8");
    } catch (e) {
      refuse(`tracker '${trackerRel}' could not be read: ${e.code || e.message}`);
    }
  }
  const folded = t.kind === "event-log" ? foldLedgerEvents(text, trackerRel) : null;
  const rows = folded ? folded.rows : parseLedger(text, trackerRel);
  // THE ACCEPTANCE ANCHOR, read from the SAME bytes the fold read — never a second
  // read of the file. A re-read here would let the anchor describe a different revision
  // than the fold and the signature gate did, which is the two-reads gap the
  // `committedBytes` comment above already records closing for the append-only check.
  //
  // A line this cannot parse is SKIPPED rather than refused: `foldLedgerEvents` already
  // refuses an unreadable log (its own `unreadable line(s)` refusal), so by the time
  // control reaches here every line has been read once successfully. Skipping cannot
  // manufacture an acceptance — the failure direction is toward an OLDER anchor, which
  // makes the gate fire SOONER, never later.
  // PARSED ONCE, read twice. `lastAccepted` and `unlandedAcceptances` below are two
  // questions over the SAME records, and parsing the log a second time for the second
  // question is how the two answers start describing different revisions.
  const logRecords =
    t.kind === "event-log"
      ? text.split("\n").flatMap((l) => {
          if (l.trim() === "") return [];
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
      : null;
  // The record ids the fold DECLINED to honour. Read from the fold's own
  // `skipped[]` rather than re-derived here: a second implementation of "which
  // activations counted" is a second answer waiting to disagree with the first.
  //
  // NO FALLBACK, and that is the repair. This read used to be
  // `Array.isArray(folded.skipped) ? folded.skipped : []`, which FAILS OPEN: an
  // empty array says "nothing was skipped", which is byte-identical to a healthy
  // log, so when the producer stopped returning the key at all the consumer
  // reported clean and the whole exclusion went silently inert. A default that
  // cannot tell "no skips" from "the producer never told me" is exactly the
  // non-discriminating instrument this file refuses everywhere else. Absent now
  // REFUSES, so the next refactor that drops the field is loud instead of inert.
  const honouredSkips = t.kind === "event-log" ? requireSkipSet(folded, trackerRel) : null;
  const lastAccepted =
    t.kind === "event-log" ? lastOwnerAcceptance(logRecords, honouredSkips, todayIso()) : null;
  // THE JOIN NOBODY PERFORMED. `lastAccepted` counts owner activation RECORDS in the
  // event log; `signedOff` counts board ITEMS whose status came from a declared
  // `sources[]` file. They are two reads of two different files, joined nowhere — so
  // the acceptance channel could report a countersignature dated today while the cell
  // that countersignature NAMES rendered unchanged, and no output either surface could
  // produce would have revealed it. MEASURED 2026-09-15 IN THE OPERATOR'S MAIN CHECKOUT
  // (`~/repos/loom`), NOT in the tree that ships this comment: an owner activated
  // `F91-remove-nested-worktrees` to `Signed off`, `--check-links` reported PENDING
  // COUNTERSIGNATURE 0, and the `Signed off` cell stayed byte-identical at 0 of 26.
  // The branch this landed on forked from `dev` BEFORE that activation, so the record
  // is absent here and the state is NOT re-derivable from this tree — re-read it rather
  // than citing this line. The freshness predicate is one command:
  // `grep -c '"kind":"activation"' burndown/events.jsonl` returns 0 here and >=1 on a
  // tree carrying it. Stated this way because a bare "MEASURED <date>" in a comment is
  // the un-anchored code-surface claim `zero-tolerance.md` Rule 3e forbids, and this
  // comment sits in the instrument built to catch exactly that shape.
  //
  // This is the missing instrument, and it DISCRIMINATES: it is empty exactly when
  // every owner acceptance has reached the board, and non-empty exactly when one has
  // not. It ASSERTS NOTHING and SETS NOTHING — it reports a disagreement between two
  // surfaces and names the file that owns the losing one, which is the operator's
  // next action. Setting the status here would be an agent assigning an owner status,
  // which `burndown-traceability.md` MUST-4 forbids and which this whole ceremony
  // exists to make impossible.
  const unlandedAcceptances = [];
  // THE DENOMINATOR, carried because the numerator alone cannot be read. An empty
  // `unlandedAcceptances` satisfies "every acceptance landed" VACUOUSLY when the log
  // holds no acceptances at all, and those two states must not render identically —
  // the first is a clean result, the second is an ABSENT one.
  let acceptancesJoined = 0;
  if (t.kind === "event-log") {
    // LAST HONOURED ACTIVATION PER ITEM, because an owner may adjudicate the same item
    // twice and `OWNER_STATUSES` has five members, so that is ordinary rather than
    // contrived. Supersession is recorded in `folded.superseded[]` and NOT in
    // `skipped[]`, so `honouredSkips` does not exclude a superseded activation: joining
    // every record would compare an OLD acceptance against the CURRENT cell and report
    // a divergence whose remedy REVERSES the owner's own later decision. Last-wins
    // matches the fold's own semantics — `_walk` does `rows.set` per event in line
    // order — so this reads the same winner the projection does.
    const winner = new Map();
    for (const e of logRecords) {
      if (!e || e.kind !== "activation" || e.authority !== "owner") continue;
      if (typeof e.id !== "string" || e.id === "" || honouredSkips.has(e.id)) continue;
      if (typeof e.item_id !== "string" || typeof e.status !== "string") continue;
      winner.set(e.item_id, e);
    }
    // NORMALIZED, never `===`. The two sides are validated under DIFFERENT equalities:
    // a board status passes `ASSIGNABLE.includes(status)` (exact, case-sensitive) while
    // an activation passes an allowlist compared through `statusKey` (NFKC + whitespace
    // collapse + case fold). So `signed off` is a VALID activation status that raw
    // equality reports as diverging from a board cell reading `Signed off` — a false
    // finding naming a file that already carries the right value, and reachable through
    // the sanctioned producer, which passes `--status` to `buildEvent` verbatim.
    // `burndown-traceability.md` states the invariant: every status comparison in this
    // module normalizes through the ONE shared `statusKey`.
    const { statusKey } = eventsLib();
    for (const e of winner.values()) {
      const it = items.get(e.item_id);
      acceptancesJoined += 1;
      const on =
        typeof e.timestamp === "string" && isRealIsoDate(e.timestamp.slice(0, 10))
          ? e.timestamp.slice(0, 10)
          : "(undated)";
      const row = {
        item_id: e.item_id,
        accepted: e.status,
        accepted_by: typeof e.accepted_by === "string" ? e.accepted_by : "(unnamed)",
        on,
      };
      // OFF-BOARD IS ITS OWN CLASS, counted and reported — never dropped. An earlier
      // revision `continue`d here on the stated ground that LINK-1 already surfaced it
      // "with a better diagnosis". That was FALSE and is withdrawn: LINK-1 walks BOARD
      // ITEMS → events, so nothing walks the reverse direction and MEASURED, no finding
      // fired anywhere. Dropping these before the denominator reproduced the original
      // defect one step over — the anchor advanced, buying a fresh silence window, and
      // the join returned its most reassuring state. It is reachable through the
      // sanctioned producer, which gates `propose` on the EVENT LOG rather than the
      // board, so every id the log carries is proposable and activatable.
      if (!it) {
        unlandedAcceptances.push({ ...row, rendered: null, source: null });
        continue;
      }
      if (statusKey(it.status) === statusKey(e.status)) continue;
      // The file whose bytes decide the rendered cell — the operator's edit target.
      unlandedAcceptances.push({ ...row, rendered: it.status, source: it.lastTouchedBy });
    }
  }

  // VERIFY BEFORE THE PROJECTION IS USED — after it is COMPUTED, and the difference
  // is deliberate rather than a compromise.
  //
  // The load-bearing property is that no VERDICT rests on an unverified record, not
  // that the fold never runs. `foldLedgerEvents` is PURE — text in, plain data out,
  // no repo read, no write — so computing it is inert, and every consumer of `rows`
  // is below this line.
  //
  // Running it FIRST buys a strictly better diagnosis on the one input both gates
  // see. A line that is not a parseable record of a declared generation is
  // CORRUPTION, and the fold names it precisely ("carries 1 unreadable line(s) of 2 …
  // line 2: unknown schema"), where this gate could only say its generation is
  // undeclared and therefore its suite unknown — a true statement, a worse diagnosis,
  // and one that would SHADOW the better one. Both refuse; ordering only chooses
  // which refusal the operator reads, so it is chosen for the operator.
  let sigVerdict = null;
  if (t.kind === "event-log") {
    // WRAPPED, because an unexpected throw out of the read gate is the ONE failure
    // this file's exit-code ladder cannot describe. `verifySignedLog` reaches three
    // libraries deep, and a plain `TypeError` from any of them is not an
    // `Unrunnable` — so it rethrew, printed a stack trace carrying the operator's
    // ABSOLUTE path (the one disclosure every refusal here is worded to prevent),
    // and exited 1, the code reserved for STALE. `assertCocSignCompatible` above
    // closes the KNOWN instance of that; this converts every remaining one into the
    // typed diagnostic instead of a raw trace. An `Unrunnable` passes through
    // untouched — its message is already the right one.
    try {
      sigVerdict = verifySignedLog(repo, manifestRel, trackerRel, text, committedBytes);
    } catch (e) {
      if (e instanceof Unrunnable) throw e;
      // `e.message` is NOT interpolated: a loader/TypeError message embeds absolute
      // paths. The CLASS is named, which is what tells an operator where to look.
      refuse(
        `event log '${trackerRel}': the signature read gate threw a ${(e && e.constructor && e.constructor.name) || "non-Unrunnable error"} ` +
          `rather than returning a verdict, so the log's integrity is UNKNOWN. This is the shape a STALE ` +
          `hooks tree takes: '${SIGNED_LOG_LIB_REL}' and '${COC_SIGN_LIB_REL}' are resolved from the same ` +
          `tree as this generator and a version skew between them surfaces mid-verify. Update the hooks ` +
          `tree to match this generator. INDETERMINATE is refused, never reported as a pass.`,
      );
    }
  }

  // ── NON-EMPTINESS / UNEXPLAINED-DROP ────────────────────────────────────────
  //
  // An index that has quietly emptied is the failure mode this whole surface
  // exists around, one layer up: a consumer keyed on "how much open work is
  // there?" reads zero and goes silent, and NOTHING reports that the silence came
  // from data starvation rather than from a clear board.
  //
  // A FLOOR IS THE WRONG SHAPE and is deliberately not used. A small absolute
  // minimum fights a bulk migration, which moves the row count in large steps in
  // BOTH directions; the operator who trips it during a legitimate migration is
  // the one who switches the gate off. What is anomalous is an UNEXPLAINED
  // SHRINK, so that is what is detected: the manifest declares the row count it
  // was last reconciled at, and a DROP below it refuses until someone re-declares
  // it. Growth is free and needs no declaration.
  if (t.min_rows !== undefined) {
    if (!Number.isInteger(t.min_rows) || t.min_rows < 0) {
      refuse(
        `manifest '${manifestRel}' declares tracker.min_rows ${JSON.stringify(t.min_rows)}; ` +
          `expected a non-negative integer (the row count this ledger was last reconciled at)`,
      );
    }
    // WHAT THIS GATE MEANS UNDER `event-log`, stated because the meaning CHANGED and
    // a gate whose meaning silently changed is worse than one that was removed.
    //
    // Under `forest-ledger` a shrink is HAND-REMOVAL of rows. Under `event-log` the
    // projection is MONOTONIC IN POPULATION and no legitimate operation can shrink it.
    // The gate is therefore NOT vacuous and is NOT retired: it stops being a
    // hand-removal detector and becomes a LOG-INTEGRITY floor, and it still fires on
    // the ways the population can actually fall — a truncated log, a history rewrite
    // that dropped appends, a merge that lost a side. It simply can no longer fire on
    // ordinary work.
    //
    // It does NOT fire on unreadable lines, and an earlier revision of this comment
    // claimed it did. MEASURED on a tree where both conditions held (one corrupt line,
    // `rows.size 1 < min_rows 2`): `foldLedgerEvents` refuses on the malformed line
    // first — it is called before this block — and the min_rows message never appears.
    //
    // ── RETRACTION EXISTS NOW, AND THE PREMISE ABOVE STILL HOLDS ─────────────
    //
    // The previous revision of this comment said "there is no retraction event — the
    // kind vocabulary is closed at genesis|transition — so the projection is MONOTONIC",
    // and deferred the widening as a producer-side change it had no authority to make.
    // The vocabulary HAS now been widened (`burndown-events.js::KINDS` carries
    // `retraction`), so that sentence would today be false, and this is the reconciliation
    // rather than a restatement.
    //
    // A retraction RETIRES IN PLACE. The retracted item KEEPS its row in the fold — it
    // keeps its `value_anchor`, keeps its LINK legs, and carries the terminal status
    // `retired` — so `rows.size` is UNCHANGED by a retraction and the monotonicity this
    // floor rests on is preserved BY CONSTRUCTION rather than by convention. The gate's
    // meaning does not move: below-floor still means the log LOST records. Retirement is
    // expressed in the item's STATUS, which is what a retirement is actually about, and
    // a consumer that wants open work filters the terminal status.
    //
    // THE ALTERNATIVE WAS REJECTED, and the reason is why this shape was chosen rather
    // than merely convenient. Had a retraction REMOVED the item, this floor would have
    // had to learn to SUBTRACT the retractions it can see — and the evidence for that
    // subtraction lives INSIDE the file that shrank. A truncation deletes retraction
    // records as readily as any other, so "N rows missing, N retractions on record" and
    // "N+M rows missing, N retractions surviving" are the SAME observation here: the
    // attacker chooses how vacuous the subtraction is. A gate whose exculpatory evidence
    // is under the adversary's control is not a gate, and a retraction that made this one
    // vacuous would be a regression wearing a feature's name. Retire-in-place keeps the
    // shrink IMPOSSIBLE instead of EXPLAINED.
    //
    // The retired POPULATION is reported on the `--check-links` ROW FLOOR line rather
    // than being netted out of any count, so "3 of 267 items are retired" and "3 items
    // vanished" can never render identically.
    //
    // SCOPE, so the RETIRED line is not read as gated the way this one is: there is no
    // `min_retired` counterpart. This floor protects the POPULATION, not the retirement
    // SET, so deleting retraction lines is invisible to it — that class is caught by
    // the per-emitter `seq`/`prev_hash` chain for current-generation records and by
    // `verifyAppendOnlyPrefix` for the committed prefix, not here.
    if (rows.size < t.min_rows) {
      refuse(
        `tracker '${trackerRel}' carries ${rows.size} row(s) but the manifest declares it was last ` +
          `reconciled at ${t.min_rows}. ` +
          (t.kind === "event-log"
            ? `An APPEND-ONLY log's projection is monotonic — no ordinary operation removes an item, and a ` +
              `RETRACTION retires an item IN PLACE without removing its row — so ` +
              `EITHER the log lost records (truncated, rewritten, or merged with a side dropped), in which ` +
              `case recover the missing appends; OR the declaration was never true of this log, which is ` +
              `easy to do at migration time because it counts DISTINCT item_ids in the fold and not rows in ` +
              `the old table. Establish which before acting: lowering a correct declaration hides a real ` +
              `loss, and hunting appends that never existed wastes the session.`
            : `A ledger that SHRANK without the declaration moving is the shape an index takes when it is ` +
              `quietly emptied — and a consumer reading it then reports a clear board rather than a starved ` +
              `one. If the shrink is intended, lower tracker.min_rows in the same commit that removes the ` +
              `rows, so the drop is a reviewable diff rather than a silence.`),
      );
    }
  }

  const findings = [];
  // ── LINK-S — REPLACED, NOT WAIVED ───────────────────────────────────────────
  //
  // A projected item does not go through LINK-1/2/3 below, and this is the one place
  // that could be mistaken for a hole, so it is stated where the skip happens rather
  // than only at the class's definition.
  //
  // LINK-1 asks for a Forest-Ledger row; LINK-2 for that row's hand-written
  // `value_anchor`; LINK-3 for a context artifact carrying the id. All three are the
  // right contract for the owner's 26 — each is an item the owner asked for and each
  // warrants a stated value-anchor. For a PROJECTION they are the wrong question
  // entirely: the authoritative state is in GitHub and in `phase2-deferrals.json`, and
  // demanding a per-item value-anchor for 350-odd rows is what produced the bulk
  // agent adjudication that was then frozen.
  //
  // What REPLACES them already ran, at load time, in `resolveProjectedSource`: every
  // member resolved to a source record — a ref matching the source's declared pattern,
  // unique across the population, and for a `repo-path` source DEREFERENCED to a
  // tracked file carrying the id verbatim. A member that resolves to none REFUSES THE
  // WHOLE BUILD there, before any count exists. So by the time control reaches this
  // loop, every projected item is linked or nothing is: the skip below cannot be the
  // path by which an unlinked item slips through, because an unlinked item has already
  // made the build unrunnable.
  const projectedIds = new Set();
  for (const it of items.values()) if (it.cls === "projected") projectedIds.add(it.id);
  for (const it of items.values()) {
    if (it.cls === "projected") continue;
    if (it.id.length < MIN_ID_LEN) {
      findings.push({
        id: it.id,
        leg: "LINK-3",
        why:
          `the id is ${it.id.length} character(s); the floor is ${MIN_ID_LEN}. LINK-3 matches the id as a ` +
          `SUBSTRING of the context artifact, so a short id matches unrelated prose and the leg certifies ` +
          `nothing. Use the descriptive form ('F87-upflow-loop', not 'F87') — the bare ordinal namespace ` +
          `is reused across sessions, so it is not an identity.`,
      });
      continue;
    }
    const row = rows.get(it.id);
    if (!row) {
      findings.push({
        id: it.id,
        leg: "LINK-1",
        why:
          `no row with ID '${it.id}' in the tracker '${trackerRel}'. The burndown reports a status for it ` +
          `and there is no path from that status to the ruling behind it.`,
      });
      continue;
    }
    // `row.line` is the ledger table's line number under `forest-ledger` and the
    // event's FILE ORDINAL under `event-log`. Naming which one it is keeps the
    // refusal actionable — "tracker row 84" sends an operator to a table line that,
    // in a log, does not exist.
    const r = resolveAnchor(repo, row, roots, trackerRel);
    if (!r.ok) {
      const where = t.kind === "event-log" ? `event line ${row.line}` : `tracker row ${row.line}`;
      findings.push({ id: it.id, leg: r.leg || "LINK-2", why: `${where}: ${r.why}` });
    }
  }

  // ── COVERAGE — the denominator's own gate ───────────────────────────────────
  //
  // WHAT THIS GROUNDS. Every count in the block is tamper-evident and internally
  // rigorous and says NOTHING about which items the report was REQUIRED to carry.
  // `burndown-integrity.md` states that bound about itself: a valid token "proves
  // a figure came from the block and says NOTHING about which figures the report
  // was required to carry." So the denominator can be honest, checkable, and a
  // quarter of the real surface. Coverage is the gate that makes it a denominator
  // OF something.
  //
  // THE INVENTORY IS A COMMITTED SNAPSHOT, NOT A LIVE QUERY, and that is a
  // requirement rather than a convenience. Everything else here is reproducible
  // from a SHA: the block records `generated_from_sha` and `sources_digest`, and
  // `--check` re-derives. Reading the issue tracker at build time would make the
  // same commit produce different output on different days and would fail closed
  // on a network blip — a gate that cannot run offline is a gate that gets
  // switched off. So the inventory is a file, refreshed by a deliberate act, and
  // the refresh is a reviewable diff.
  //
  // SCOPED ON DECLARATION, like the tracker: no `inventory` key, no coverage
  // check. That is NOT a loophole to be closed by making it mandatory — a BUILD or
  // USE repo may have no issue surface this generator can see — but its absence is
  // reported as ABSENT, never as clean.
  const inv = manifest.inventory;
  if (inv !== undefined) {
    if (!inv || typeof inv.path !== "string" || !inv.path) {
      refuse(`manifest '${manifestRel}' declares an 'inventory' with no 'path'`);
    }
    const invPath = assertRepoRelative(manifestRel, "inventory.path", inv.path);
    const invRel = manifestDir ? path.posix.join(manifestDir, invPath) : invPath;
    assertCommittedAndUnmodified(repo, invRel);
    const invDoc = readJson(path.join(repo, invRel), "inventory", invRel);
    if (!Array.isArray(invDoc.items)) refuse(`inventory '${invRel}' has no items[] array`);

    // A migration_baseline written into the inventory DOCUMENT is INERT: this
    // builder reads it from the MANIFEST node below. That is not hypothetical —
    // it is exactly what this repo shipped, and the whole block (expiry,
    // self-acceptance, stale-exemption) was dead for weeks while `--check-links`
    // and the manifest's own note both printed that the protection was live.
    // Silence is the defect, so the misplacement is REFUSED rather than ignored.
    if (invDoc.migration_baseline !== undefined) {
      refuse(
        `inventory '${invRel}' declares a 'migration_baseline', but it is read from the ` +
          `MANIFEST node ('${manifestRel}'::inventory.migration_baseline), never from the ` +
          `inventory document. A declaration here is INERT — every refusal it is supposed to ` +
          `carry would silently never run. Move it to the manifest node.`,
      );
    }

    // The MIGRATION BASELINE. Without it this gate refuses on day one against a
    // pre-existing backlog, and the first person it blocks turns it off — the
    // always-refusing-assertion failure `worktree-isolation.md` Rule 1 records.
    // With an OPEN-ENDED exemption it becomes permanent by default, which is the
    // condition `trust-posture.md` § "Every Phase-2 Deferral Carries A DATED
    // Declaration" exists to prevent. So: dated, owner-accepted, and it EXPIRES.
    const base = inv.migration_baseline;
    let exempt = new Set();
    if (base !== undefined) {
      for (const need of ["reason", "expires", "accepted_by"]) {
        if (typeof base[need] !== "string" || !base[need]) {
          refuse(
            `inventory '${invRel}' declares a migration_baseline with no '${need}'. An undated or ` +
              `unattributed backfill exemption is permanent by default.`,
          );
        }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(base.expires)) {
        refuse(`inventory '${invRel}' migration_baseline.expires '${base.expires}' is not YYYY-MM-DD`);
      }
      // The agent that PROPOSES a residual cannot also ACCEPT it
      // (`completion-criterion.md` MUST-6). Refused explicitly rather than left to
      // convention, because the convention is exactly what an agent under time
      // pressure writes past.
      //
      // DELEGATED to the library's ONE predicate (see `isAgentAcceptor` above). This
      // line used to compare CASE-SENSITIVELY against two of the four words, so `Agent`
      // and `the agent` both passed it while the log validator refused them.
      if (isAgentAcceptor(base.accepted_by)) {
        refuse(
          `inventory '${invRel}' migration_baseline.accepted_by is '${base.accepted_by}'. The party ` +
            `proposing a backfill exemption cannot also accept it; this needs the owner.`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (base.expires < today) {
        refuse(
          `inventory '${invRel}' migration_baseline EXPIRED on ${base.expires} (today is ${today}). ` +
            `An expired baseline stops excusing anything: either the migration landed and the entry ` +
            `should be removed, or it did not and that is the finding.`,
        );
      }
      if (!Array.isArray(base.uncovered_ids)) {
        refuse(
          `inventory '${invRel}' migration_baseline has no uncovered_ids[] array. The exemption is ` +
            `ENUMERATED, never a count: a count lets a NEW uncovered item hide inside the allowance.`,
        );
      }
      exempt = new Set(base.uncovered_ids);
    }

    const seenInv = new Set();
    for (const row of invDoc.items) {
      if (!row || typeof row.id !== "string" || !row.id) refuse(`inventory '${invRel}': an item has no id`);
      if (seenInv.has(row.id)) refuse(`inventory '${invRel}' declares item '${row.id}' more than once`);
      seenInv.add(row.id);
      if (rows.has(row.id)) continue;
      // A PROJECTED id satisfies coverage WITHOUT a tracker row, and this is not a
      // waiver dressed as a skip. Coverage asks "is this inventory item carried by the
      // burndown, with a path from its status to the ruling behind it?" — and for a
      // projected item that path is LINK-S, which already resolved it to its SOURCE
      // RECORD at load time. Requiring a tracker row ON TOP would demand the very
      // hand-adjudication this class removes, and would be satisfiable by backfilling
      // rows nobody reads. It is NOT the `migration_baseline` exemption: that one is
      // dated, enumerated and expires, because it excuses an UNRESOLVED item; this is a
      // RESOLVED item resolved a different way, so it needs no expiry.
      if (projectedIds.has(row.id)) continue;
      if (exempt.has(row.id)) continue;
      findings.push({
        id: row.id,
        leg: "COVERAGE",
        why:
          `is in the inventory '${invRel}' but has no row in the tracker '${trackerRel}', and no ` +
          `migration_baseline entry excuses it. The burndown's denominator would exclude it silently, ` +
          `so every percentage computed from this block would be a percentage of the wrong population.`,
      });
    }
    // A baseline naming ids that are no longer uncovered is STALE, and a stale
    // exemption is how a migration reports itself finished while carrying rows.
    // `projectedIds` joins this test for the same reason `rows` is in it: an id that is
    // now resolved — by a tracker row OR by LINK-S — is no longer uncovered, and an
    // exemption that outlives what it excused hides the NEXT gap behind an allowance
    // nobody rechecks. Omitting it would let a migrated id stay permanently exempt after
    // the projection started resolving it.
    const stale = [...exempt].filter((id) => rows.has(id) || projectedIds.has(id) || !seenInv.has(id));
    if (stale.length > 0) {
      refuse(
        `inventory '${invRel}' migration_baseline names ${stale.length} id(s) that are no longer ` +
          `uncovered (${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}). Remove them: an ` +
          `exemption that outlives what it excused hides the NEXT gap behind an allowance nobody rechecks.`,
      );
    }
  }

  if (findings.length > 0) {
    const shown = findings.slice(0, 30);
    refuse(
      // THE DENOMINATOR IS THE POPULATION THIS LOOP EXAMINED, not the whole board.
      // `items.size` would state a ratio against items LINK-1/2/3 never looked at, which
      // is `burndown-integrity.md` MUST-2's own failure: a count whose denominator names
      // a different population than the bucket.
      `the traceability chain is BROKEN for ${findings.length} of ${items.size - projectedIds.size} ` +
        `ADJUDICATED item(s)${projectedIds.size > 0 ? ` (${projectedIds.size} projected item(s) resolve through LINK-S instead and are not in this denominator)` : ""}. ` +
        `Every burndown item must resolve id → tracker row → context artifact, or a reader gets a status ` +
        `word with nowhere to go:\n` +
        shown.map((f) => `  ${f.leg}  ${f.id}: ${f.why}`).join("\n") +
        (findings.length > shown.length ? `\n  … and ${findings.length - shown.length} more` : "") +
        (t.kind === "event-log"
          ? `\nAppend the missing events to '${trackerRel}' through the signed append path rather than ` +
            `editing it by hand — that is the producer's discipline, and NOT something this gate can ` +
            `verify: it reads no signature and compares the log against no prior revision. Statuses are ` +
            `the OWNER's to adjudicate; the links are not optional.`
          : `\nBackfill the tracker at '${trackerRel}'. Statuses are the OWNER's to adjudicate; the links are not optional.`),
    );
  }
  return {
    trackerRel,
    kind: t.kind,
    rows,
    roots,
    // `checked` is now the ADJUDICATED population — the items that went through
    // LINK-1/2/3 — and NOT `items.size`. Leaving it as the whole population would have
    // made `--check-links` claim that every item "resolves id → row → context artifact",
    // which is false for a projected item and would be the strictly worse failure of a
    // green over-claiming what it examined. The projected count is reported separately,
    // with its own resolution named.
    checked: items.size - projectedIds.size,
    projected: projectedIds.size,
    projectedSources: (manifest.sources || [])
      .filter((s) => s && PROJECTED_KINDS.has(s.kind))
      .map((s) => s.path),
    coverage: manifest.inventory === undefined ? null : true,
    superseded: folded ? folded.superseded : null,
    // The RETIRED ids, carried out so the ROW FLOOR line can state them. A retraction
    // retires in place, so `rows.size` alone cannot tell a board with retirements from
    // one without — and letting those two render identically is the failure class this
    // whole surface exists around.
    retired: folded ? folded.retired : null,
    // The PENDING proposals, carried out so the verdict can name them. See the
    // PENDING line in `--check-links`.
    pendingProposals: folded ? folded.pendingProposals : null,
    // The ACCEPTANCE anchor, carried out so `build()` can run the channel gate without
    // a second read of the log. `null` means "no owner acceptance in this log" for an
    // event-log tracker, and "this tracker kind has no acceptance records at all" for a
    // forest-ledger one — the caller distinguishes them by `kind`, and the gate treats
    // both as "clock runs from acceptance.armed_on", which is the correct reading for
    // each: neither has ever seen a countersignature.
    lastAccepted,
    // The owner acceptances that did NOT reach the board. Carried out so the acceptance
    // line can state the two quantities it prints are two reads of two files, and say
    // so POSITIVELY when they disagree. `null` for a non-event-log tracker, which has no
    // activation records at all — distinguished from `[]` ("every acceptance landed")
    // because those are opposite facts and must not render identically.
    unlandedAcceptances: t.kind === "event-log" ? unlandedAcceptances : null,
    // The population the join COULD speak about. Without it an empty numerator is
    // unreadable: it is the same value for "every acceptance landed" and "no acceptance
    // has ever been made".
    acceptancesJoined: t.kind === "event-log" ? acceptancesJoined : null,
    minRows: t.min_rows === undefined ? null : t.min_rows,
    // The read gate's OWN counts, carried out to the verdict. See the SIGNATURES
    // line in `--check-links` for why printing them is not decoration.
    signatures: sigVerdict,
  };
}

// ── LIVE SOURCES ────────────────────────────────────────────────────────────
//
// WHAT THIS STOPS. A source that froze the WRONG NOUN. `burndown/migrated-2026-08-22.json`
// is a STATIC SNAPSHOT of two LIVE registries — 241 rows of `{id, page, status}` captured
// on one day — declared `kind: growth`, and nothing re-derives it. Measured on this tree
// on 2026-09-06, four months of movement invisible in a block that reported itself clean:
//
//   Open issues       block says 102, `gh issue list --state open` says 107
//                     (19 issues ARRIVED, 14 DRAINED, net +5 — and BOTH numbers were lost,
//                      not just the net, so even the net's smallness is an accident)
//   Deferral registry block says 139, `phase2-deferrals.json` says 97
//                     (42 DRAINED — 18 probe suites graduated and the block never noticed)
//
// A membership set is legitimately permanent. A COUNT of a live registry is not. So a live
// source freezes ONLY the ORIGINAL ID SET (`original_ids`) plus the adjudication attached to
// those ids, and re-derives CURRENT MEMBERSHIP by running a declared command:
//
//   live ∩ original   → the frozen adjudication applies; `origin` is whatever the first
//                       source introducing that id already assigned (see `resolveItems`)
//   live − original   → ARRIVED since the freeze; no adjudication exists, so it takes the
//                       source's declared `arrival_defaults`
//   original − live   → DRAINED. It simply drops out. That is the movement the static
//                       snapshot could not express at all.
//
// THE ORIGIN COLUMN IS NOT TOUCHED, and that is deliberate rather than incidental.
// `resolveItems` assigns `origin` from the FIRST source introducing an id, and this extends
// that mechanism by feeding it a LIVE item list — it does not replace it. So the migrated
// items stay `arrived since` and the register's original 26 stay `from the original
// register`, which is exactly what that file's own `_note` says folding them into the
// register would have destroyed (`burndown-integrity.md` MUST-3's highest-value column).
//
// FAIL CLOSED, WITH NO SNAPSHOT FALLBACK. If the command is missing, errors, times out, or
// returns fewer members than the declared floor, the build REFUSES (exit 2, no block). A
// fallback to the frozen snapshot would reinstate the exact defect this closes, silently and
// at the worst possible moment — the moment the live surface became unreadable.
//
// AND THE FRESHNESS GATE LEARNS IT. `sources_digest` is a digest of COMMITTED BLOBS, so it
// could never tell "these sources have not moved" from "these sources CANNOT move": a static
// file passes it trivially, forever. A live source therefore contributes its RESOLVED
// MEMBERSHIP to the digest (see `sourcesDigest`), so the digest moves when the subject moves
// and the movement is detectable rather than invisible. It is not a red on its own: whose
// difference it is — a declared file's or the tracker's — is decided by the adjudication
// `--check` and `--promote` share (`adjudicateDeclared`), which compares the block's own
// DECLARED-derived identity and reports the live movement separately.
// ── PROJECTED SOURCES ───────────────────────────────────────────────────────
//
// `live-growth` fixed MEMBERSHIP drift. It did not fix STATUS drift, and for one
// population it could not: `original_ids` + `items[]` is a FROZEN PER-ITEM
// ADJUDICATION, and a per-item adjudication of 241 migrated rows, ~107 live GitHub
// issues and ~97 deferral rows is a judgement nobody performs at that volume. It was
// performed once, in bulk, by an agent, and frozen — `migrated-2026-08-22.json` says
// so in its own `_note` (`_authority: agent`, "the agent's UNDER-claiming reading, not
// an owner declaration"). THE FREEZE IS THE SYMPTOM. The defect is forcing a
// PROJECTION of an external registry through a contract written for the owner's ask.
//
// A `projected` source is that population's own class. Four properties, each a
// REFUSAL rather than a convention:
//
//   1. STATUS IS DERIVED FROM THE SOURCE RECORD. The query emits a per-member STATE
//      and the source declares a `status_derivation.map` translating that registry's
//      vocabulary into this one. There is NO per-item status field: `items[]` MUST be
//      empty, and a non-empty one REFUSES. An unmapped state REFUSES — there is no
//      default, because a default is the silent fallback that made the freeze
//      invisible in the first place. A member whose source record CLOSED is not in the
//      query's output, so it is not in the population at all.
//   2. `Signed off` IS UNREACHABLE. That value means the OWNER accepted the item and
//      it is the ONLY status counting toward completion (`burndown-integrity.md`
//      MUST-4). No agent may mark the owner's work accepted on their behalf, so it is
//      refused at every path that could assign it: as a `status_derivation.map` TARGET,
//      via a `status-refresh` aimed at a projected id, and via any other source
//      declaring the same id. Structurally impossible, not merely unwritten.
//   3. LINK-1/2/3 ARE REPLACED, NEVER WAIVED — by LINK-S, below.
//   4. THE GROWTH SPLIT IS UNTOUCHED. A projected source is not `register`, so
//      `resolveItems` assigns `arrived-since` by the rule it already had. Nothing here
//      reaches the origin column.
//
// ── LINK-S — what "resolves to its SOURCE RECORD" means, and why ─────────────
//
// REJECTED CANDIDATE, stated because it is the obvious one: "the id appears in the
// live membership output". That is TRUE BY CONSTRUCTION for every projected item —
// the population IS that output — so no result it could produce would falsify the
// proposition (`instrument-discipline.md` MUST-1). It is the same tautology
// `checkLinks`'s `anchor_roots` floor refuses when a root admits the register: a
// chain verifying itself against its own source, passing for every item forever.
//
// LINK-S is therefore a SECOND field the query must emit per member: a RECORD
// REFERENCE, shape-constrained by a `record_ref.pattern` the SOURCE declares and the
// query does not choose, and UNIQUE across the population. A member with no ref, a
// malformed ref, or a ref shared with another member REFUSES the whole build. That is
// falsifiable on real data: a query that half-fails at exit 0, or a registry row with
// no addressable record, produces exactly those shapes.
//
// STRICTLY STRONGER THAN A HAND-WRITTEN `value_anchor`, on the axis that matters: an
// anchor is typed once by a person and then ROTS SILENTLY — it keeps passing while the
// thing it describes changes underneath. A record ref is RE-DERIVED FROM THE
// AUTHORITATIVE REGISTRY on every build, so a record that disappeared cannot leave a
// stale-but-passing pointer behind; the item leaves the population instead.
//
// AND THE BOUND, stated rather than claimed shut. Two ref kinds, DECLARED per source,
// never sniffed:
//   `repo-path`  the registry is a file in THIS repo (a deferral registry). The ref is
//                DEREFERENCED: tracked at HEAD, and it must carry the id VERBATIM.
//                This is a full resolution, offline.
//   `external`   the registry is remote (GitHub). The ref is checked for SHAPE and
//                UNIQUENESS and is NOT fetched. Offline determinism is a hard
//                requirement here — the same commit must produce the same block on any
//                day, and a gate that cannot run offline is a gate that gets switched
//                off. So `external` establishes ADDRESSABILITY, not existence, and
//                `--check-links` PRINTS that bound rather than letting a green be read
//                as more than it is.
const KINDS = new Set(["register", "growth", "status-refresh", "live-growth", "projected"]);
const LIVE_KINDS = new Set(["live-growth", "projected"]);
const PROJECTED_KINDS = new Set(["projected"]);
const REF_KINDS = Object.freeze(["repo-path", "external"]);
// Compiled once per source, and both the pattern and the refs it is applied to are
// LENGTH-BOUNDED. Stated exactly, because the bound is easy to over-read: this caps
// the INPUT SIZE, and it is NOT a ReDoS proof — a short catastrophic pattern is still
// catastrophic. What actually carries the risk here is the same thing that carries it
// for `membership.command`: the pattern lives in a COMMITTED, reviewed source file
// held to `assertCommittedAndUnmodified`, so it is a reviewable diff rather than an
// attacker's input. The bound is defence in depth over that, not a substitute for it.
const MAX_REF_PATTERN_CHARS = 512;
const MAX_REF_CHARS = 512;

// The declared command is spawned with NO SHELL and a hard wall-clock bound. A query that
// hangs is not a slow pass — it is an unanswered question, and it refuses like any other.
const MEMBERSHIP_TIMEOUT_MS = 60_000;
const MEMBERSHIP_MAX_BYTES = 4 * 1024 * 1024;

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A REAL calendar date, not merely a well-shaped string. `2026-02-30` and `2026-13-01`
 * both satisfy the regex and both are silently NORMALISED by `Date.UTC` into some other
 * day — which would move a staleness boundary by an amount nobody declared.
 */
function isoToUtcMs(d) {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
}
function isRealIsoDate(d) {
  if (typeof d !== "string" || !ISO_DATE_RX.test(d)) return false;
  const ms = isoToUtcMs(d);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
}
function daysBetween(fromIso, toIso) {
  return Math.round((isoToUtcMs(toIso) - isoToUtcMs(fromIso)) / 86400000);
}
/**
 * The acceptance channel, rendered for the BOARD rather than for a terminal.
 *
 * This line exists because the artifact people READ is the block, not the check output.
 * The block already states "A page is complete only when `Signed off` equals
 * `adjudicated`" and then, truthfully, that no page is complete — a sentence that has
 * been true for the whole life of this board while nothing indicated that the channel
 * which produces `Signed off` had never once fired. The completion sentence and the
 * state of the mechanism it depends on belong next to each other.
 *
 * NEVER a burndown count: it carries no token, it is no page's row, and it must not be
 * quoted as a figure. It states its anchor and both bounds so a reader who doubts it
 * re-derives it in one command.
 *
 * ONE LINE, NO EXPLANATORY PARAGRAPH, unlike its `promotion_gap` sibling — a deliberate
 * departure, recorded rather than left to look like an omission. Every prose paragraph
 * in this block is compared VERBATIM against two HAND-COMPUTED oracles
 * (`audit-fixtures/burndown-integrity/selftest/{a,b}/EXPECTED.md`), whose whole value is
 * that a human derived them independently of this code. A paragraph here would have to
 * be transcribed into both, and every later edit to its wording would red the one
 * instrument that proves this generator can produce a different answer for different
 * inputs — pressure to regenerate those oracles from the thing they check, which would
 * turn the selftest into a tautology that passes for ever. The line carries state,
 * anchor, both bounds and the re-derive command, so nothing is lost but the duplication.
 *
 * The REFUSAL is not in this line and is not cosmetic: it runs inside `build()`, so a
 * board past its bound produces NO BLOCK AT ALL to render or hand-edit.
 */
function renderAcceptance(a) {
  if (!a || a.state === "absent") {
    return `ABSENT — no 'acceptance' node is declared, so NOTHING bounds how long owner acceptance may stay silent. Not a clean result.`;
  }
  if (a.state === "not-applicable") {
    return `n/a — ${a.adjudicated} adjudicated item(s), ${a.outstanding} outstanding, so the channel has nothing to accept`;
  }
  const anchor =
    a.lastAccepted === null
      ? `no owner acceptance has EVER been recorded; measured from acceptance.armed_on ${a.armedOn}`
      : `last owner acceptance ${a.lastAccepted}`;
  return (
    `${a.state.toUpperCase()} — silent ${a.silentDays}d (warn >${a.warnAfter}d, REFUSE >${a.refuseAfter}d); ` +
    `${a.outstanding} of ${a.adjudicated} adjudicated unaccepted; ${anchor}. Re-derive: burndown-build.mjs --check-links`
  );
}

/** TODAY in UTC. Named so a test can see there is exactly one clock read in this file's live path. */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── DERIVED FLOORS ──────────────────────────────────────────────────────────
//
// WHY THE HAND-TYPED FLOOR HAD TO GO, stated as the measured failure rather than a
// preference. On 2026-09-13 this build was UNRUNNABLE (exit 2) because
// `projected-deferrals.json::membership.min_members` said 70 while the live query
// returned 37. Nothing was broken: the registry had legitimately drained 76 -> 37
// (e23773933). The GATE was right and the NUMBER was stale — it had been chosen against
// a population that then moved by 39 without anyone touching it.
//
// That is not an operator failing to keep a number current. It is the number being in
// the WRONG UNITS. An ABSOLUTE floor is denominated in members of a population whose
// whole purpose is to drain, so it goes stale by doing nothing, and the only remedy the
// old refusal could offer was "lower it in the same commit as the explanation" — which
// trains the operator to lower it reflexively, and a fail-loud gate lowered on reflex is
// a formality. The sibling `tracker.min_rows` had already decayed the same way in the
// other direction: declared 267 against a live 367.
//
// WHAT REPLACES IT, and the property that had to survive. The floor is now DERIVED from
// the LAST SUCCESSFUL BUILD'S OWN MEASUREMENT (`burndown/observed-floors.json`, written
// by `--write`, committed, reviewable) and a DECLARED SCALE-FREE TOLERANCE. A ratio does
// not decay when the population moves — that is the entire difference, and it is the
// reason this is a fix rather than the same defect one file over.
//
// THE GATE IS NOT WEAKENED, and this is the load-bearing claim. A query that HALF-FAILS
// AT EXIT 0 — returning zero, or a small fraction of the true population — still REFUSES,
// because a half-failure is by construction a LARGE single-build drop and the tolerance
// bounds exactly that. What re-grounds automatically is the ORDINARY case the old shape
// could not tell from a failure: a handful of rows genuinely graduating. A drop larger
// than the tolerance is NOT auto-accepted; it refuses and requires `--reground --reason`,
// which records a measured value and a human sentence instead of asking someone to guess
// a new absolute number.
//
// WHAT IS NOT CLOSED, written down rather than claimed shut: a TRUE population that
// declines gradually, within tolerance on every single build, walks the floor down with
// it. That is intended — a genuine drain to zero is this registry's SUCCESS state, and
// refusing it would be the gate fighting the work. What cannot happen silently is a
// COLLAPSE, which is the failure mode, and every step is a committed diff.

/** The tolerance's bounds. A fraction at or above 1 accepts a drop to zero — the gate switched off while every field stays populated, which is the `as_of`-in-the-future shape. At or below 0 it refuses every drain including a correct one, which is the gate operators disable. */
const MIN_DROP_FRACTION = 0.01;
const MAX_DROP_FRACTION = 0.75;
/** Structural sanity limit on the acceptance bounds — see checkAcceptanceChannel. */
const MAX_ACCEPTANCE_DAYS = 365;

/**
 * How many `armed_on`-touching revisions back this will look. Not a policy number: the
 * candidate list below carries ONE entry per commit that added, removed or changed the
 * `armed_on` line, so a board would need this many separate re-armings to reach it.
 */
const ARMED_ON_HISTORY_CAP = 50;

/**
 * The `armed_on` value that the CURRENT one replaced, read from git history.
 *
 * `null` means there is none to find — the field has only ever held this value, or the
 * history does not reach one within the cap. The caller reads that as "initial arming",
 * which is the correct reading of both.
 *
 * WHY HISTORY AND NOT `HEAD`. The obvious check — compare the declared value against
 * `git show HEAD:<manifest>` — is a NON-DISCRIMINATING INSTRUMENT here, and saying so is
 * the point: `loadManifest` holds the manifest to `assertCommittedAndUnmodified`, so by
 * the time any of this runs the working tree and `HEAD` are BYTE-IDENTICAL BY
 * CONSTRUCTION. That comparison prints "unchanged" on an honest board and on a re-armed
 * one alike; there is no output it could produce that would distinguish them. The prior
 * value lives one commit further back, and nowhere else.
 *
 * THE CANDIDATE LIST IS THE CHEAP HALF. `git log -G'"armed_on"'` returns only the commits
 * whose diff for this file ADDED or REMOVED a line carrying that field — on this repo,
 * measured, exactly ONE (the commit that introduced the acceptance node) against THREE
 * for a field edited three times and ZERO for a field that never existed. So the walk is
 * one or two blob reads, not one per commit in the file's history.
 *
 * AN ABSENT NODE IS NOT AN ANSWER, and this is the half that closes the two-commit
 * bypass. A revision where the acceptance node was deleted — or the manifest not yet
 * created, or momentarily unparseable — carries no `armed_on` to compare, so the walk
 * CONTINUES past it rather than reporting "no prior". Otherwise removing the node in one
 * commit and re-adding it with today's date in the next would launder the re-arming into
 * a first arming, which is a cheaper edit than the one this exists to refuse.
 */
function priorArmedOn(repo, manifestRel, current) {
  const listed = gitCaptureOrNull(repo, [
    "log",
    `--max-count=${ARMED_ON_HISTORY_CAP}`,
    "--format=%H",
    "-G",
    '"armed_on"',
    "--",
    manifestRel,
  ]);
  // A git that could not answer is INDETERMINATE, and the caller is told so rather than
  // handed a `null` that reads exactly like "this value has no predecessor". `gitOk`'s
  // asymmetry, one function over, records why that distinction is kept everywhere here.
  if (listed === null) return { state: "indeterminate", value: null };
  const shas = listed
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sha of shas) {
    // The PARENT of a commit that touched the line holds what that commit replaced.
    // A root commit has none, and `git show` fails — which is the same "nothing behind
    // this" the loop treats as inconclusive and walks past.
    const raw = gitCaptureOrNull(repo, ["show", `${sha}^:${manifestRel}`]);
    if (raw === null) continue;
    let doc = null;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    const v = doc && doc.acceptance && typeof doc.acceptance === "object" ? doc.acceptance.armed_on : undefined;
    if (!isRealIsoDate(v)) continue; // node absent, or the field unusable — not an answer
    if (v === current) continue; // this commit changed the line without changing the date
    return { state: "found", value: v };
  }
  return { state: "none", value: null };
}

/**
 * The floor a measurement of `observed` implies under tolerance `frac`.
 *
 * `Math.max(1, ...)` is deliberate and is what stops the ratchet reaching zero on its
 * own: from any NON-ZERO observation the floor stays at least 1, so a query returning 0
 * refuses.
 *
 * STATED EXACTLY, because an earlier draft of this comment over-claimed it as "a query
 * returning 0 ALWAYS refuses" and that is FALSE. From an observation of 0 the floor is 0
 * and a query returning 0 BUILDS. That is the intended terminal state — a registry
 * genuinely burnt down to nothing is this board's success condition, and a gate that
 * could not express it would be a gate fighting the work.
 *
 * WHAT IT COSTS TO GET THERE is the protection, and this paragraph is a SECOND
 * correction: it used to read "a 0 observation can only arrive through an explicit
 * `--reground <subject> --reason`", as though `deriveFloor`'s own arithmetic settled it.
 * It did not, and the code 130 lines below refuted it — a hand-written record saying
 * `{"members": 0, "by": "build"}` reached this function with no sentence, no reground and
 * no refusal, because the reason requirement was asked only of a `reground`. The claim is
 * now TRUE, and it is true because `checkAgainstDerivedFloor` REFUSES that record (see
 * § ZERO IS THE ONE OBSERVATION THAT SWITCHES THE FLOOR OFF), not because of anything
 * here. Two facts, not one: `deriveFloor` never walks to 0 by itself (measured: from 37
 * at tolerance 0.25 the auto-descent terminates at 3), AND the consumer refuses a 0 that
 * did not come through a reground.
 *
 * WHAT IS STILL OPEN, named rather than folded into the sentence above: a hand-written
 * `by: "build"` observation carrying a SMALL NON-ZERO number lowers that subject's floor
 * with no sentence required, and nothing here can tell it from a real measurement. It
 * does not disable the gate — any non-zero observation derives a floor of at least 1, so
 * a query returning 0 still refuses — but it does shrink it. Closing that needs
 * provenance this file cannot carry (a record signed by the build that took it), and
 * until it does the protection is the committed diff a reviewer reads. Defence in depth,
 * not reliance: both shipped query scripts independently `die()` on zero rows, so a 0
 * reading does not reach this function today at all.
 */
function deriveFloor(observed, frac) {
  if (observed <= 0) return 0;
  return Math.max(1, Math.ceil(observed * (1 - frac)));
}

/**
 * Load the committed measurement file.
 *
 * DECLARED in the manifest, never discovered, for the reason the manifest's own
 * `_note` gives for sources: adding one is a reviewable diff. Held to
 * `assertCommittedAndUnmodified` for the reason every source is — a floor read from an
 * uncommitted working-tree edit is a floor the reviewer never saw.
 *
 * It is deliberately NOT a `sources[]` entry. A source contributes to `sourcesDigest`,
 * so re-grounding one would move the digest, mark every outstanding quote stale and make
 * `--write` a two-commit dance with itself. This file carries no items and no counts; it
 * is bookkeeping ABOUT the sources, so it stays out of block identity.
 */
function loadFloors(repo, manifestRel, manifest) {
  const f = manifest.floors;
  // SCOPED TO WHAT IT GOVERNS. A board declaring no live or projected source runs no
  // membership query, so there is no population to floor and demanding the node would be
  // a bound that bounds nothing — the shape this file already refuses for `as_of` on a
  // projection. This is not a softening: a board WITH a live source gets a hard refusal
  // below, and that is every board carrying the defect.
  //
  // It also keeps the ecosystem honest. This binary ships via `always_include` while the
  // manifests that drive it do NOT, so making a new node unconditionally mandatory would
  // hard-break every downstream board on its next pull — the breaking-change-with-no-
  // deprecation-cycle this file already records for the `forest-ledger` kind.
  const hasLive = (manifest.sources || []).some((s) => s && (LIVE_KINDS.has(s.kind) || PROJECTED_KINDS.has(s.kind)));
  if (f === undefined) {
    if (!hasLive) return null;
    refuse(
      `manifest '${manifestRel}' declares a live/projected source but no 'floors' node. Every live source's ` +
        `shrink floor is DERIVED from the last successful build's own measurement, so without this node ` +
        `there is no floor at all — and a projected population drains SILENTLY by design, which is exactly ` +
        `the case a missing gate renders as progress. Absent never reads as unbounded.\n` +
        `  Declare it:  "floors": { "path": "burndown/observed-floors.json", "max_drop_fraction": 0.25 }\n` +
        `  Then seed each source's measurement, ONE AT A TIME:\n    burndown-build.mjs --reground --subject <source-path> --reason "<why this count is right>"\n` +
        `  (This REPLACES the per-source 'membership.min_members', which is superseded and now refused: an ` +
        `absolute floor is denominated in members of a draining population, so it decays by doing nothing.)`,
    );
  }
  if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.path !== "string" || !f.path) {
    refuse(`manifest '${manifestRel}' declares a 'floors' node with no usable 'path' string`);
  }
  const frac = f.max_drop_fraction;
  if (typeof frac !== "number" || !Number.isFinite(frac) || frac < MIN_DROP_FRACTION || frac > MAX_DROP_FRACTION) {
    refuse(
      `manifest '${manifestRel}' declares floors.max_drop_fraction ${JSON.stringify(frac)}; expected a ` +
        `number in [${MIN_DROP_FRACTION}, ${MAX_DROP_FRACTION}]. This is the ONE policy number here a human ` +
        `owns, and it is a RATIO on purpose: an absolute floor is denominated in members of a draining ` +
        `population and goes stale by doing nothing, which is the defect this node replaces.`,
    );
  }
  const manifestDir = path.dirname(manifestRel) === "." ? "" : path.dirname(manifestRel);
  const fPath = assertRepoRelative(manifestRel, "floors.path", f.path);
  const rel = manifestDir ? path.posix.join(manifestDir, fPath) : fPath;
  assertCommittedAndUnmodified(repo, rel);
  const doc = readJson(path.join(repo, rel), "floors", rel);
  if (doc._schema !== FLOORS_SCHEMA) {
    refuse(`floors '${rel}' declares _schema ${JSON.stringify(doc._schema)}, expected '${FLOORS_SCHEMA}'`);
  }
  const obs = doc.observations;
  if (!obs || typeof obs !== "object" || Array.isArray(obs)) {
    refuse(`floors '${rel}' carries no 'observations' object`);
  }
  return { rel, abs: path.join(repo, rel), doc, frac, obs };
}

/**
 * The floor for ONE named subject, plus the refusal when the live reading is below it.
 *
 * `subject` is the key into `observations` — a source's repo-relative path, or
 * `tracker:<path>` for the row floor. Named rather than positional so a reordered
 * manifest cannot silently re-point one subject's floor at another's measurement.
 *
 * A MISSING observation REFUSES. It does not default to zero and does not accept the
 * live reading as its own baseline: a floor that adopts whatever it was first handed
 * certifies the very first half-failed query as the truth, and every later one against it.
 */
/**
 * The recorded observation for `subject`, or a NULL-valued shape when there is none.
 *
 * Used only for REPORTING (`--json`). It returns a shape rather than refusing, because
 * under `--reground` a subject legitimately has no prior record yet — and a reporting
 * path that refuses where the gate path deliberately does not would make `--json` stricter
 * than the build it describes.
 */
function floorRecordFor(floors, subject) {
  const rec = Object.prototype.hasOwnProperty.call(floors.obs, subject) ? floors.obs[subject] : null;
  if (!rec || !Number.isInteger(rec.members)) return { prior: null, at: null };
  return { prior: rec.members, at: rec.at };
}

function checkAgainstDerivedFloor(floors, subject, live, what) {
  const rec = Object.prototype.hasOwnProperty.call(floors.obs, subject) ? floors.obs[subject] : null;
  if (!rec || typeof rec !== "object" || Array.isArray(rec) || !Number.isInteger(rec.members) || rec.members < 0) {
    refuse(
      `floors '${floors.rel}' carries no usable observation for '${subject}'. A derived floor needs a PRIOR ` +
        `measurement to be derived FROM; adopting this run's reading as the baseline would certify a ` +
        `half-failed query as the truth. Record one:\n` +
        `  node .claude/bin/burndown-build.mjs --reground --subject ${subject} --reason "<why this count is correct>"`,
    );
  }
  // ── THE CONSUMER ENFORCES WHAT THE PRODUCER PROMISES ──────────────────────
  //
  // MEASURED as a defect before this block existed: `--reground` demanded a >=24-char
  // sentence, while HAND-EDITING the floors file demanded nothing at all — no `by`, no
  // `reason`, and an `at` of 2099-12-31 passed on shape alone. The sanctioned path was
  // strictly STRICTER than the unsanctioned one, which inverts the incentive it exists
  // to create; and this file's own `_note` ("Nothing here is chosen; every number came
  // out of the declared membership query") was a claim about the PRODUCER that no
  // consumer checked. A promise nothing reads is documentation, not a gate.
  if (rec.by !== "build" && rec.by !== "reground") {
    refuse(
      `floors '${floors.rel}' observation '${subject}' carries by ${JSON.stringify(rec.by)}; expected ` +
        `'build' (banked automatically inside the declared tolerance) or 'reground' (an operator asserting ` +
        `a larger drop is real). A record that does not say WHICH is a number of unknown provenance, and ` +
        `the whole point of this file is that its numbers came from the query rather than from a keyboard.`,
    );
  }
  if (rec.by === "reground" && (typeof rec.reason !== "string" || rec.reason.trim().length < REGROUND_REASON_MIN)) {
    refuse(
      `floors '${floors.rel}' observation '${subject}' is by 'reground' but carries no usable reason ` +
        `(>= ${REGROUND_REASON_MIN} characters). A reground SUSPENDS the one gate standing between a ` +
        `genuinely drained population and a query that half-failed at exit 0, so the record must carry the ` +
        `sentence a reviewer can disagree with. Hand-editing this file to dodge that sentence is the ` +
        `unsanctioned path being easier than the sanctioned one.`,
    );
  }
  if (rec.by === "build" && rec.reason !== null && rec.reason !== undefined) {
    refuse(
      `floors '${floors.rel}' observation '${subject}' is by 'build' but carries a reason. An automatic ` +
        `bank stays INSIDE the declared tolerance and needs no justification; a reason here means the ` +
        `record was hand-assembled, and its 'by' is then not evidence of anything.`,
    );
  }
  // ── ZERO IS THE ONE OBSERVATION THAT SWITCHES THE FLOOR OFF ────────────────
  //
  // The check above closed the `reground` arm of "the sanctioned path must not be
  // STRICTER than the unsanctioned one" and left the `build` arm open. MEASURED on the
  // shape that resulted: a hand-written `{"members": 0, "at": <today>, "by": "build"}`
  // passed EVERY check in this function — the integer test admits 0, `by` is in the
  // vocabulary, the >=24-character reason is demanded only of a `reground`, and omitting
  // a reason is what a `build` record is required to do. `deriveFloor(0, frac)` is then
  // 0 and `live < 0` is never true, so that subject's floor was disabled PERMANENTLY, by
  // an edit carrying no sentence at all. It cost strictly LESS than the `reground` route
  // the paragraph above was written to make expensive.
  //
  // A 0 from `build` is also not something the producer can ever write: `bankMeasurements`
  // banks only when a value MOVED, and reaching 0 from any non-zero prior refuses here
  // first (the floor is at least 1 for a non-zero observation). So this refusal costs a
  // legitimate run nothing — it rejects exactly the record no build could have produced.
  //
  // THE TERMINAL STATE IS STILL EXPRESSIBLE, and that is deliberate: a genuinely drained
  // registry re-grounds to 0 through `--reground`, which stamps `by: "reground"` and the
  // operator's sentence. Burning down to nothing stays this board's success condition;
  // what it no longer is, is something a keyboard can assert in silence.
  if (rec.by === "build" && rec.members === 0) {
    refuse(
      `floors '${floors.rel}' observation '${subject}' records 0 members by 'build'. A zero observation ` +
        `derives a floor of 0, and nothing is below 0 — so this subject's floor would admit every ` +
        `reading, including the zero a query returns when it HALF-FAILS AT EXIT 0, which is the single ` +
        `case this whole mechanism exists to catch. No build writes this record: an automatic bank only ` +
        `fires on a value that moved, and a move to 0 from any non-zero prior refuses at the floor first. ` +
        `A drained population is a real state and is recorded as a CLAIM, not as a measurement that ` +
        `happened by itself:\n` +
        `  node .claude/bin/burndown-build.mjs --reground --subject ${subject} --reason "<why 0 is the true population>"`,
    );
  }
  if (!isRealIsoDate(rec.at)) {
    refuse(`floors '${floors.rel}' observation '${subject}' carries at ${JSON.stringify(rec.at)}; expected YYYY-MM-DD`);
  }
  if (daysBetween(rec.at, todayIso()) < 0) {
    refuse(
      `floors '${floors.rel}' observation '${subject}' carries at ${rec.at}, which is in the FUTURE (today ` +
        `is ${todayIso()}). A measurement cannot have been taken tomorrow; a future date is the signature ` +
        `of a hand-written record, and it is the same edit this file refuses for a future 'armed_on' and a ` +
        `future 'as_of' — every field populated, nothing measured.`,
    );
  }
  const floor = deriveFloor(rec.members, floors.frac);
  if (live < floor) {
    refuse(
      `${what} returned ${live}, below the DERIVED floor of ${floor}. That floor is not a number anyone ` +
        `typed: it is the last successful build's own measurement of ${rec.members} (taken ${rec.at}), less ` +
        `the declared tolerance of ${floors.frac}. A drop this size is equally consistent with a genuinely ` +
        `drained population and with a query that HALF-FAILED AT EXIT 0, and those must not render ` +
        `identically. If the smaller number is CORRECT, record it as a measurement rather than guessing a ` +
        `new floor:\n` +
        `  node .claude/bin/burndown-build.mjs --reground --subject ${subject} --reason "<why ${live} is the true population>"`,
    );
  }
  return { floor, prior: rec.members, at: rec.at };
}

const FLOORS_SCHEMA = "burndown-observed-floors/v1";

/**
 * A `min_members` left in a source REFUSES, and is not merely ignored.
 *
 * This is the same fence `loadSources` already points at an inert `membership` block, for
 * the same measured reason: a silently-dropped declaration is the WORST outcome available,
 * because its PRESENCE is what a later reader cites as proof the source is floored. A
 * stale 70 sitting in a file next to a derived floor of 28 is a number someone will
 * believe.
 */
function assertNoLegacyMinMembers(mem, rel) {
  if (mem.min_members !== undefined) {
    refuse(
      `source '${rel}' declares membership.min_members ${JSON.stringify(mem.min_members)}, which is ` +
        `SUPERSEDED and no longer read. An absolute floor is denominated in members of a population whose ` +
        `purpose is to drain, so it goes stale by doing nothing — MEASURED 2026-09-13, when a floor of 70 ` +
        `refused a build whose live count of 37 was CORRECT. The floor is now DERIVED from the last ` +
        `successful build's own measurement in the manifest's 'floors' file, less the declared ` +
        `'floors.max_drop_fraction'. Delete this key; leaving it would read as a live floor to anyone ` +
        `reviewing the source.`,
    );
  }
}

// ── THE ACCEPTANCE CHANNEL ──────────────────────────────────────────────────
//
// THE MEASURED FINDING. Across all 635 records in `burndown/events.jsonl`: `activation`
// records 0, `authority: "owner"` records 0, effective `Signed off` statuses 0. The one
// occurrence of the string "Signed off" anywhere in the log is a `proposed_status` on a
// `kind: "proposal"` record whose own status is the neutral passthrough — INERT by
// construction, awaiting a countersignature that has never come.
//
// So the acceptance channel has a PRODUCER (`burndown-countersign.mjs propose/activate`),
// a FENCE (`validateEvent` refuses an agent-authored owner status), and a CONSUMER (the
// fold honours an activation). What it has never had is a FORCING FUNCTION. Every other
// landing channel in this repo refuses loudly when it stalls; this one refuses nothing,
// so it silently never runs, and `Signed off` sits at 0 against a non-zero `adjudicated`
// while the board reports "No page is complete" as PROSE — which is a description, not a
// gate, and nobody is paged by a description.
//
// WHY AN AGE BOUND AND NOT A COUNT. A count gate ("at least N signed off") is the
// hand-typed-floor defect wearing a different hat, and it would brick this board on day
// one: 26 items are already at 0. What is actually anomalous is not that work is
// unaccepted — that is ordinary — but that the CHANNEL ITSELF has not been exercised for
// longer than the owner declared they would let it go. The vocabulary is deliberately the
// one this file already uses for a frozen adjudication (`as_of` / `max_age_days`), so the
// gate reads as a sibling of a check the reader has already met rather than a new idea.
//
// WHY IT CANNOT BE SATISFIED BY AN AGENT. The anchor is the timestamp of a folded
// `activation`, and `burndown-events.js::validateEvent` already requires an activation to
// carry `authority: "owner"` (bound to a committed-roster role by `verifyAuthorityClaim`),
// a status inside `OWNER_STATUSES`, and an `accepted_by` that is not an agent. NONE of
// that is touched here — this gate READS that fence's output and adds no path around it.
// `burndown-traceability.md` MUST-4 stands exactly as written: statuses are the OWNER's.
// An agent that wants this gate quiet must get a human to countersign, which is the
// behaviour the gate exists to force.

/**
 * The fold's skipped-record ids, as a Set — REFUSING if the fold did not report them.
 *
 * Separate from its one call site so the refusal cannot be re-inlined as a `|| []` by a
 * later edit that only wants the happy path.
 */
function requireSkipSet(folded, rel) {
  if (!folded || !Array.isArray(folded.skipped)) {
    refuse(
      `the fold of '${rel}' returned no 'skipped' array, so this build cannot tell which activations it ` +
        `DECLINED to honour. Defaulting to "nothing was skipped" is indistinguishable from a healthy log ` +
        `and is how the acceptance anchor's fold-honoured check went silently inert once before: an ORPHAN ` +
        `activation, landing no status and moving no cell, still bought a full window of silence. ` +
        `'hooks/lib/burndown-events.js' no longer matches this generator.`,
    );
  }
  return new Set(folded.skipped.map((s) => s && s.record_id));
}

/**
 * The most recent OWNER acceptance in the log, or null if there has never been one.
 *
 * Counts an `activation` ONLY. A `proposal` is deliberately excluded even though it
 * carries `proposed_status: "Signed off"`: it is inert, an agent may author it, and
 * letting it move this anchor would hand the agent the disarm switch this whole gate is
 * built to deny. That is the single most important discrimination in this function.
 */
function lastOwnerAcceptance(records, skippedRecordIds, today) {
  let latest = null;
  for (const e of records) {
    if (!e || e.kind !== "activation") continue;
    // OWNER AUTHORITY. Belt AND braces: `validateEvent` already refuses an
    // agent-authored activation, and a record that fails it is an INVALID_RECORD skip,
    // which the fold counts as UNREADABLE and REFUSES the whole log over. So this line
    // is unreachable on a log that folded at all — it is kept because this function's
    // whole job is to decide what counts as an owner acceptance, and inferring that
    // property from a fence in another module is how the property quietly changes.
    if (e.authority !== "owner") continue;
    // HONOURED BY THE FOLD, OR IT DOES NOT COUNT. An activation the fold fenced out —
    // orphaned, item-mismatched or status-mismatched — sets no cell and, in the fold's
    // own words, "adjudicates nothing". A record that adjudicates nothing must not
    // disarm the gate that watches for adjudication either: otherwise the cheapest way
    // to buy another `refuse_after_days` of silence is to append an activation naming a
    // proposal that does not exist, which lands no status and looks like progress.
    //
    // POSITIVELY IDENTIFIED, THEN POSITIVELY HONOURED — in that order, and the first
    // half is not ceremony. `validateEvent`'s REQUIRED_FIELDS_FOR_KIND is built from
    // `_BASE_FIELDS` (item_id, item, value_anchor, status, source); `id` is a STAMPED
    // field the append path writes, and is NOT required by validation. So a record can
    // reach this loop with no `id` at all. When it did, `e.id` was `undefined`, the
    // fold's skip entry carried `record_id: undefined` too, and `has(undefined)` came
    // back true — so an id-less activation was excluded BY COINCIDENCE: two independent
    // `undefined`s meeting in a Set. Coincidence is not a fence. It inverts the moment
    // anything upstream stops pushing skip entries for records it could not identify.
    //
    // Fail closed instead: an activation this function cannot NAME cannot be shown to
    // have been honoured, so it does not advance the anchor. The failure direction is
    // toward an OLDER anchor, which makes the gate fire SOONER — never later.
    if (typeof e.id !== "string" || e.id === "") continue;
    if (skippedRecordIds.has(e.id)) continue;
    if (typeof e.timestamp !== "string") continue;
    const day = e.timestamp.slice(0, 10);
    if (!isRealIsoDate(day)) continue;
    // A FUTURE-DATED RECORD CANNOT BUY SILENCE. Clamped rather than refused: the log is
    // append-only and may legitimately carry a record stamped by a host with a skewed
    // clock, so refusing would make an unrelated machine's clock able to brick the
    // board. Clamping to today keeps the anchor at its most generous HONEST value —
    // a record dated next year buys exactly as much as one dated today, and no more.
    // Same failure this file already fences for a future `as_of` and a future
    // `armed_on`; the difference is that those are DECLARATIONS someone typed, where
    // refusing is right, and this is EVIDENCE, where clamping is.
    const effective = day > today ? today : day;
    if (latest === null || effective > latest) latest = effective;
  }
  return latest;
}

/**
 * REFUSE when the acceptance channel has been silent past its declared bound while
 * adjudicated work sits unaccepted. WARN first, so the refusal is never a surprise.
 *
 * Returns a render-ready verdict so `--check-links` and `--json` can state the channel's
 * state POSITIVELY — "silent for N days, budget M" — because a gate that only speaks when
 * it fires is one nobody knows is armed, which is how the `migration_baseline` block in
 * this same repo sat DEAD for weeks while two surfaces asserted it was live.
 */
function checkAcceptanceChannel(repo, manifest, manifestRel, all, lastAccepted, trackerKind) {
  const a = manifest.acceptance;
  // A GATE THAT CANNOT BE CLEARED IS A GATE THAT GETS SWITCHED OFF — so it refuses at
  // DECLARATION time rather than mysteriously sixty days later.
  //
  // The anchor advances only on an `activation` record, and only an `event-log` tracker
  // carries those. A board declaring this node with no tracker at all, or with a
  // `forest-ledger` tracker, would sit quiet through its warn window and then refuse
  // permanently with no action available to the operator — the countersign tool has
  // nowhere to append. Refusing here names the real problem at the moment someone
  // writes the declaration, while it is still one line to fix.
  if (a !== undefined && trackerKind !== "event-log") {
    refuse(
      `manifest '${manifestRel}' declares an 'acceptance' node, but its tracker kind is ` +
        `${trackerKind === null ? "ABSENT" : `'${trackerKind}'`} — not 'event-log'. The acceptance anchor ` +
        `advances only on an owner 'activation' record, and only an event log carries one, so this bound ` +
        `could never be cleared by any action available to the operator: it would go quiet, then refuse ` +
        `for ever. Declare tracker.kind 'event-log', or remove the acceptance node and accept that nothing ` +
        `bounds the channel's silence (which --check-links will then report as ABSENT, never as clean).`,
    );
  }
  // ABSENT IS A THIRD VERDICT, and it is the one this repo already uses for an
  // undeclared `inventory` and for LINK-S on a board with no projected source. It is NOT
  // "clean": every surface below PRINTS it as absent, so a board running without the
  // gate says so on every run rather than reporting a checked-and-quiet channel.
  //
  // It is not a hard refusal for the reason `loadFloors` records above — this binary
  // ships ecosystem-wide while manifests do not, so an unconditional new requirement
  // would refuse every downstream board on its next pull of the binary, which is how a
  // gate gets reverted rather than adopted. The board that HAS the defect is the board
  // that declares the node, and it is fully gated.
  if (a === undefined) {
    return {
      state: "absent",
      adjudicated: all.adjudicated,
      signedOff: all.signedOff,
      outstanding: all.adjudicated - all.signedOff,
      armedOn: null,
      // Shape parity with the live verdict below: a consumer reading `armedOnCheck`
      // must not have to know which branch produced the object. There is no node, so
      // there is no date to have advanced.
      armedOnCheck: "not-required",
      armedOnPrior: null,
      lastAccepted,
      anchor: null,
      silentDays: null,
      warnAfter: null,
      refuseAfter: null,
    };
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    refuse(`manifest '${manifestRel}' declares an 'acceptance' node that is not an object`);
  }
  for (const k of ["warn_after_days", "refuse_after_days"]) {
    // BOUNDED AT BOTH ENDS, and the upper bound is the load-bearing one.
    //
    // Below 1 the gate refuses on the day it lands — the gate that gets switched off.
    // Above a year it is the OTHER failure, and the subtler one: every field stays
    // populated, `--check-links` still prints a state, and the bound bounds nothing.
    // That is precisely the shape this file already refuses for a future `as_of` and a
    // future `armed_on`, and refusing it here closes the one manifest edit that could
    // disarm this gate while leaving it looking armed.
    //
    // MAX_ACCEPTANCE_DAYS is a STRUCTURAL sanity limit, not a policy number — the
    // policy is the operator's `refuse_after_days` inside it, exactly as
    // MAX_DROP_FRACTION bounds the operator's tolerance. A calendar year is the
    // longest span over which "this channel is merely quiet" stays an honest reading.
    if (!Number.isInteger(a[k]) || a[k] < 1 || a[k] > MAX_ACCEPTANCE_DAYS) {
      refuse(
        `manifest '${manifestRel}' declares acceptance.${k} ${JSON.stringify(a[k])}; expected an integer ` +
          `in [1, ${MAX_ACCEPTANCE_DAYS}]. Below 1 the gate refuses on the day it lands, which is the gate ` +
          `that gets switched off. Above ${MAX_ACCEPTANCE_DAYS} it is the subtler failure: every field ` +
          `stays populated and a state still prints, while the bound bounds nothing — the same edit as a ` +
          `future 'armed_on', wearing the grammar of a configured gate.`,
      );
    }
  }
  if (a.warn_after_days >= a.refuse_after_days) {
    refuse(
      `manifest '${manifestRel}' declares acceptance.warn_after_days ${a.warn_after_days} at or above ` +
        `refuse_after_days ${a.refuse_after_days}. The warning would arrive with, or after, the refusal it ` +
        `exists to precede — a ladder with one rung, reading as two.`,
    );
  }
  // ONE PREDICATE, not a third reading of the same question. This line used to test
  // `/\bagent\b/i` locally and its comment claimed that was "the same standard"
  // `inventory.migration_baseline.accepted_by` is held to. MEASURED, it was not, in
  // EITHER direction: `"assistant"` was refused there and accepted here, `"the agent"`
  // accepted there and refused here. Both sites now call `isAgentAcceptor`, so the claim
  // below is a statement about one shared function rather than about two that happened
  // to be described the same way.
  if (typeof a.accepted_by !== "string" || !/[a-z]/i.test(a.accepted_by) || isAgentAcceptor(a.accepted_by)) {
    refuse(
      `manifest '${manifestRel}' declares acceptance.accepted_by ${JSON.stringify(a.accepted_by)}. This ` +
        `bound is a POLICY an owner sets on themselves, so it names a HUMAN — decided by the SAME ` +
        `predicate (burndown-events.js::isAgentAcceptor) that inventory.migration_baseline.accepted_by ` +
        `and every activation record in the log are held to, and for ` +
        `completion-criterion.md MUST-6's reason: the party a gate constrains cannot be the party that ` +
        `waives it.`,
    );
  }
  const today = todayIso();
  if (!isRealIsoDate(a.armed_on)) {
    refuse(`manifest '${manifestRel}' declares acceptance.armed_on ${JSON.stringify(a.armed_on)}; expected YYYY-MM-DD`);
  }
  if (daysBetween(a.armed_on, today) < 0) {
    refuse(
      `manifest '${manifestRel}' declares acceptance.armed_on ${a.armed_on}, which is in the FUTURE (today ` +
        `is ${today}). A future arming date disables this gate for as long as it stays future, while every ` +
        `field reads as populated — the one edit that switches it off invisibly. Same fence, same reason, ` +
        `as membership.as_of.`,
    );
  }
  // ── `armed_on` MAY NOT ADVANCE ON ITS OWN ──────────────────────────────────
  //
  // The future check above fences ONE direction and the cheaper edit is the other one.
  // `armed_on` feeds the anchor directly (three lines below), so moving it FORWARD to
  // today sets `silentDays` to 0 unconditionally: on day 59 of a 60-day budget, a
  // one-token date edit buys another 60 days, and it can be made again on day 59 of
  // that. The refusal this gate exists to deliver is reachable only by an operator who
  // never touches the file.
  //
  // It is also the QUIETER edit of the two the comment on `refuse_after_days` names. An
  // out-of-range `refuse_after_days: 400` is conspicuous in a diff and answers to a
  // structural bound; a date moving forward is INDISTINGUISHABLE in a diff from the
  // legitimate first arming of a new board, and nothing structural bounds it. That is
  // why the check is here and not a range.
  //
  // THE ESCAPE IS THE CHANNEL ITSELF, which is what keeps this from being a gate that
  // cannot be cleared. An `activation` at or after the PRIOR arming date is the owner
  // acting — exactly what the bound exists to require — and after one the date may move
  // freely. Note that it then buys nothing anyway: `lastAccepted` already outranks
  // `armed_on` in the anchor below, so on a board whose channel is firing this check has
  // nothing to refuse. It bites only where no acceptance has happened at all, which is
  // the only state in which re-arming is worth doing.
  //
  // INDETERMINATE IS NOT A PASS, and it is not a refusal either. If git cannot answer,
  // the build says so on its own line rather than banking silence as monotonicity — the
  // third verdict this file keeps everywhere. Refusing outright would let an unrelated
  // git failure brick a board; reporting clean would be the non-discriminating read.
  let armedOnPrior = null;
  let armedOnCheck = "not-required";
  if (lastAccepted === null || lastAccepted < a.armed_on) {
    // Skipped when an acceptance already stands at or after the declared arming: no
    // prior value could then produce a refusal (any prior is EARLIER than `armed_on`,
    // and `lastAccepted` is at or after it), so the history read would be work whose
    // outcome cannot change the verdict.
    const prior = priorArmedOn(repo, manifestRel, a.armed_on);
    armedOnCheck = prior.state;
    armedOnPrior = prior.value;
    if (prior.state === "found" && a.armed_on > prior.value) {
      const accepted = lastAccepted !== null && lastAccepted >= prior.value;
      if (!accepted) {
        refuse(
          `manifest '${manifestRel}' ADVANCED acceptance.armed_on from ${prior.value} to ${a.armed_on} ` +
            `while no owner acceptance has been recorded at or after ${prior.value}` +
            `${lastAccepted === null ? " (none has EVER been recorded)" : ` (the latest is ${lastAccepted})`}.\n` +
            `  The arming date is the anchor this channel's silence is measured from, so moving it ` +
            `forward resets that silence to zero — the same disarming as a future date, spelled as a ` +
            `date that has already passed, and repeatable on the day before every refusal for ever.\n` +
            `  This is not a bound to re-tune: the channel's CLOCK is reset by USING it. Append an ` +
            `activation and the date may move, because by then the acceptance has already bought the ` +
            `silence this date would have bought:\n` +
            `    node .claude/bin/burndown-countersign.mjs pending\n` +
            `    node .claude/bin/burndown-countersign.mjs activate …  # OWNER-run\n` +
            `  MEASURED, and stated here because the opposite was claimed: an activation resets the ` +
            `CLOCK and does NOT drain the COUNT. 'unaccepted' is 'adjudicated - signedOff' over BOARD ` +
            `items whose status comes from the declared sources[]; an activation is a RECORD in the ` +
            `tracker log, which is not a status source. To move the count the OWNER must also set the ` +
            `item's status in the source file that declares it. See the ACCEPTANCE LANDING line, which ` +
            `names every acceptance that has not reached the board.\n` +
            `  If the board was DELIBERATELY re-armed after a period with no acceptance node, that is a ` +
            `decision with a reviewer, not a date edit: restore ${prior.value} and record the decision.`,
        );
      }
    }
  }
  // The ANCHOR. A real acceptance outranks the arming date; with none, the clock runs
  // from arming, which is what keeps day one green on a board already sitting at zero.
  const anchor = lastAccepted !== null && lastAccepted > a.armed_on ? lastAccepted : a.armed_on;
  const silentDays = daysBetween(anchor, today);
  const outstanding = all.adjudicated - all.signedOff;
  const verdict = {
    armedOn: a.armed_on,
    // The monotonicity read, carried out so every surface can state it POSITIVELY.
    // `not-required` an acceptance already outranks the arming date, so no advance
    //               could have bought anything and the history was not read;
    // `none`         the field has only ever held this value — an initial arming;
    // `found`        it replaced `armedOnPrior`, and that advance was justified;
    // `indeterminate` git could not answer. NOT a pass — printed as its own state.
    armedOnCheck,
    armedOnPrior,
    lastAccepted,
    anchor,
    silentDays,
    warnAfter: a.warn_after_days,
    refuseAfter: a.refuse_after_days,
    adjudicated: all.adjudicated,
    signedOff: all.signedOff,
    outstanding,
    state: "quiet",
  };
  // NOTHING TO ACCEPT is not the same as ACCEPTED, and neither is a finding. A board
  // with no adjudicated items, or with none outstanding, gives the channel nothing to
  // do, so its silence carries no information and must not be scored as a stall.
  if (all.adjudicated === 0 || outstanding === 0) {
    verdict.state = "not-applicable";
    return verdict;
  }
  if (silentDays > a.refuse_after_days) {
    verdict.state = "refused";
    refuse(
      `the ACCEPTANCE CHANNEL has been silent for ${silentDays} day(s), past the declared bound of ` +
        `${a.refuse_after_days}, while ${outstanding} adjudicated item(s) sit unaccepted ` +
        `(${all.signedOff} of ${all.adjudicated} signed off).\n` +
        `  Last owner acceptance: ${lastAccepted === null ? `NONE EVER — clock runs from acceptance.armed_on ${a.armed_on}` : lastAccepted}\n` +
        `  'Signed off' is the ONLY route to completion on this board, so a channel that never fires is a ` +
        `board that accretes for ever while every page truthfully reports "not complete" and nothing ` +
        `refuses. This is that refusal.\n` +
        `  An agent CANNOT clear this by setting a status — burndown-traceability.md MUST-4, enforced by ` +
        `validateEvent. The channel is:\n` +
        `    node .claude/bin/burndown-countersign.mjs pending     # what is awaiting countersignature\n` +
        `    node .claude/bin/burndown-countersign.mjs activate …  # OWNER-run; requires owner authority\n` +
        `  If the bound itself is wrong, that is an OWNER decision and a reviewable diff to ` +
        `'acceptance.refuse_after_days' in ${manifestRel}.`,
    );
  }
  if (silentDays > a.warn_after_days) {
    verdict.state = "warning";
    // stderr, and LOUD, because stdout carries the block a caller may be piping.
    process.stderr.write(
      `\nACCEPTANCE CHANNEL WARNING — silent ${silentDays} day(s); this build REFUSES past ` +
        `${a.refuse_after_days} (in ${a.refuse_after_days - silentDays} day(s)).\n` +
        `  ${outstanding} adjudicated item(s) unaccepted; ${all.signedOff} of ${all.adjudicated} signed off.\n` +
        `  ${lastAccepted === null ? "NO owner acceptance has EVER been recorded." : `Last owner acceptance ${lastAccepted}.`}\n` +
        `  Clear it: node .claude/bin/burndown-countersign.mjs pending\n\n`,
    );
  }
  return verdict;
}

/**
 * Per-build state. Set unconditionally at the top of `loadSources`, so a process that
 * builds several repos (the selftest does) can never read one repo's floors against
 * another's sources — the failure a lazily-initialised module global would produce.
 */
let FLOORS = null;
/** Measurements this build took, for `--write`/`--reground` to bank. Reset with FLOORS. */
let MEASURED = [];
/**
 * `--reground` SUSPENDS the floor refusal — and nothing else. Every other gate in this
 * file still runs, so a re-ground of a log that fails its append-only prefix, or of a
 * source that is uncommitted, still refuses. It is a narrow suspension of ONE check by
 * an operator who is asserting, in a recorded sentence, that the smaller number is real.
 */
let REGROUND_REASON = null;
/**
 * The ONE subject `--reground` may suspend and bank. `null` outside a reground.
 * Per-subject rather than global: see `bankMeasurements` for the measured defect.
 */
let REGROUND_SUBJECT = null;
/** Long enough that "ok" and "fixed" do not clear it. Not a quality bar — a deliberation bar. */
const REGROUND_REASON_MIN = 24;

/**
 * Bank this build's measurements into the committed floors file.
 *
 * Writes ONLY when a value actually moved, so an ordinary `--write` on an unchanged
 * population leaves the tree clean and the file's git history carries one entry per real
 * change rather than one per build.
 *
 * The write makes the file DIFFER from HEAD, which means the NEXT build refuses on
 * `assertCommittedAndUnmodified` until it is committed. That is the intended shape, not a
 * wart: the brief for this mechanism is a COMMITTED measurement, and a floor that
 * re-grounds in a working tree nobody commits is a floor with no reviewer. It costs one
 * commit — the same commit the regenerated block is already going into.
 */
function bankMeasurements(floors, measured, reason, onlySubject) {
  const today = todayIso();
  const moved = [];
  for (const m of measured) {
    // PER-SUBJECT, and this bound is load-bearing rather than tidy.
    //
    // MEASURED as a defect before this line existed: with two projected sources, where
    // A drains legitimately 37 -> 30 and B COLLAPSES 95 -> 2 — the half-failed-query-at-
    // exit-0 case this whole mechanism exists to catch — one `--reground` banked BOTH,
    // and stamped B's 98% collapse with a reason sentence that talked only about A. The
    // provenance was WORSE than useless because it was TRUE: a reviewer cannot disagree
    // with an accurate sentence, and nothing in the record said it was about a different
    // row. The refusal text even walked the operator into it by naming the bare command.
    //
    // So a re-ground now names ONE subject and touches nothing else. Two genuine
    // re-groundings are two commands, two reasons and two reviewable lines — which is
    // the correct price, because they are two independent claims about the world.
    if (onlySubject !== null && m.subject !== onlySubject) continue;
    const prior = Object.prototype.hasOwnProperty.call(floors.obs, m.subject) ? floors.obs[m.subject] : null;
    if (prior && prior.members === m.members) continue;
    moved.push({ subject: m.subject, from: prior ? prior.members : null, to: m.members });
    floors.obs[m.subject] = {
      members: m.members,
      at: today,
      by: reason === null ? "build" : "reground",
      // NULL on an automatic re-ground, and that asymmetry is the point: an automatic
      // one needs no justification because it stayed INSIDE the declared tolerance, and
      // inventing a sentence for it would train a reader to skim the field on the rows
      // where it is load-bearing.
      reason: reason === null ? null : reason,
    };
  }
  if (moved.length === 0) return moved;
  fs.writeFileSync(floors.abs, JSON.stringify(floors.doc, null, 2) + "\n");
  return moved;
}

/**
 * Resolve `command[0]` to an absolute path this tool is willing to execute.
 *
 * A BARE NAME IS REFUSED. The rationale is the one already written above `gitBinary()`:
 * PATH is attacker-influenceable, and a shim named `gh` would answer the question that
 * BECOMES the counts. Two forms are accepted, and both are things a reviewer can check:
 * an ABSOLUTE path, or a REPO-RELATIVE path held to the same committed-and-unmodified
 * standard as every declared source — so a live query runs a reviewed artifact or it does
 * not run at all.
 */
function resolveMembershipBinary(repo, manifestRel, rel, raw) {
  let abs;
  if (path.isAbsolute(raw)) {
    abs = raw;
  } else if (raw.includes("/") || raw.includes("\\")) {
    const manifestDir = manifestDirOf(manifestRel);
    const clean = assertRepoRelative(manifestRel, `source '${rel}' membership.command[0]`, raw);
    const binRel = manifestDir ? path.posix.join(manifestDir, clean) : clean;
    assertCommittedAndUnmodified(repo, binRel);
    abs = path.join(repo, binRel);
  } else {
    refuse(
      `source '${rel}' declares membership.command[0] '${safeCell(raw)}', a BARE NAME resolved through ` +
        `PATH. PATH is attacker-influenceable and this command's OUTPUT BECOMES THE COUNTS, so a shim ` +
        `of that name would answer the question the block reports. Declare an ABSOLUTE path, or a ` +
        `repo-relative path to a COMMITTED script.`,
    );
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    refuse(
      `source '${rel}' declares membership.command[0] which does not resolve to a file (${e.code || e.message}). ` +
        `A live source whose query cannot even be located REFUSES — it does not fall back to its snapshot.`,
    );
  }
  if (!st.isFile()) {
    refuse(`source '${rel}' declares membership.command[0] which is not a regular file`);
  }
  return abs;
}

/**
 * Run the declared command and return its member ids.
 *
 * OUTPUT CONTRACT: newline-delimited ids on stdout, one per line, blank lines ignored.
 * Anything else — a non-zero exit, a spawn failure, a timeout, an id carrying whitespace
 * or a control character, a duplicate id, an id below the join-key floor — REFUSES.
 * The output is UNTRUSTED DATA: it is validated before it is allowed to become a count.
 */
/**
 * The PATH a membership query runs under — a DECLARED CONSTANT, never the ambient one.
 *
 * `gitNetEnv()` pins PATH to `/usr/bin:/bin`, which is correct for `git` (it lives
 * there) and UNUSABLE for a query. MEASURED, not reasoned about: a committed
 * `#!/usr/bin/env node` query script exited 127 with `env: node: No such file or
 * directory`, because no package manager installs an interpreter into either directory.
 * That left only two ways to run a script query, and BOTH are worse than this list:
 * naming an absolute interpreter in `membership.command[0]`, which is host-specific and
 * — because `resolveMembershipBinary` validates only `command[0]` — leaves the SCRIPT
 * itself unheld to `assertCommittedAndUnmodified`; or a shell wrapper, which adds a
 * second unverified file. With this list the query script IS `command[0]`, repo-relative,
 * and committed-and-unmodified on every build.
 *
 * WHAT THIS DOES NOT DO: consult the ambient PATH. The list is a literal in a committed
 * file, so which directories are searched is a reviewable diff and not an environment
 * variable an attacker can set.
 *
 * THE TRADE, STATED: `/opt/homebrew/bin` and `/usr/local/bin` are admin-writable on a
 * shared host where `/usr/bin` is root-only, so this is a real, if small, widening. It
 * buys nothing an attacker did not already have here — a query that reads GitHub must
 * reach `gh`, which lives in exactly those directories — and it is the same bar
 * `burndown-query-issues.mjs::GH_SEARCH_DIRS` already sits at.
 */
const MEMBERSHIP_PATH_DIRS = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/home/linuxbrew/.linuxbrew/bin",
  "/snap/bin",
]);

function membershipEnv() {
  const env = gitEnvLib().gitNetEnv();
  env.PATH = MEMBERSHIP_PATH_DIRS.join(path.delimiter);
  const home = process.env.HOME;
  if (home && !/[\0\n\r]/.test(home)) {
    try {
      if (fs.statSync(home).isDirectory()) env.HOME = home;
    } catch {
      /* absent or unreadable HOME is DROPPED, never guessed */
    }
  }
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0 && !/[\0\n\r]/.test(v)) env[k] = v;
  }
  return env;
}

/**
 * `recordMode` is FALSE for `live-growth` (one bare id per line, the contract that
 * shipped) and TRUE for `projected`, whose lines are TAB-separated `id\tstate\tref`.
 *
 * ONE FUNCTION, TWO CONTRACTS, and the branch is on a DECLARED KIND rather than on
 * the output's shape. Sniffing "does this line contain a tab?" would make a query that
 * half-emitted its extra fields read as a valid bare-id line — a silent fallback into
 * the wrong contract, which is the class `zero-tolerance.md` Rule 3 forbids. The id
 * validation below is shared verbatim, so a projected id is held to exactly the same
 * join-key floor, control-byte and duplicate rules.
 */
function runMembershipQuery(repo, manifestRel, rel, mem, recordMode = false) {
  const bin = resolveMembershipBinary(repo, manifestRel, rel, mem.command[0]);
  let out;
  try {
    out = execFileSync(bin, mem.command.slice(1), {
      cwd: repo,
      // ENV IS BUILT FROM CONSTANTS, never inherited (git-env-regrowth-guard 1471-G7c).
      // An earlier revision passed no `env:` at all and documented that as an accepted
      // departure. It is not one: `-C` and `cwd:` choose a DIRECTORY, while an inherited
      // GIT_DIR chooses the REPOSITORY, so a resolved binary with an ambient env is still
      // fully steerable — and this query's output BECOMES the counts of record.
      //
      // `gitNetEnv()` is the base because it already neutralises the config an attacker
      // could reach and forwards the egress/TLS/SSH set a corporate host needs. It is not
      // sufficient alone: it carries no HOME and pins PATH to /usr/bin:/bin, and the
      // membership query is typically `gh`, which reads its credentials from HOME and
      // would fail closed on every host. So exactly three names are forwarded, each
      // shape-checked, and nothing else:
      //   HOME  — where gh finds hosts.yml; dropped unless it is an existing directory
      //   GH_TOKEN / GITHUB_TOKEN — the credential itself, dropped unless it is a
      //           single-line non-empty string (a newline would let a value forge a
      //           second variable in some spawn paths)
      // The token reaches a binary this file already resolves strictly — absolute, or
      // repo-relative and committed-and-unmodified, never PATH-resolved — so the set of
      // programs that can receive it is the set the manifest could already name.
      env: membershipEnv(),
      encoding: "utf8",
      // stdin is CLOSED. A query that stops to prompt would otherwise hang to the
      // timeout and refuse for the wrong stated reason.
      stdio: ["ignore", "pipe", "pipe"],
      // THE AMBIENT ENVIRONMENT IS INHERITED HERE, and that is a NAMED departure from the
      // `gitEnvForArgs` envelope every `git` in this file runs under — recorded rather than
      // left for a reader to infer it was overlooked. The envelope exists because `GIT_DIR`
      // SILENTLY RE-TARGETS a repository read whose answer is this gate's trust root. A
      // membership query is a different shape: it is a manifest-declared, committed,
      // reviewed executable that must reach the operator's credentials (HOME, a token) to
      // run at all, and an allowlist here would be a guess at what every future declared
      // query needs — failing closed in the way that gets a gate switched off. WHAT SURVIVES:
      // an attacker who can set this process's environment can influence which registry the
      // query reads. That is narrower than it looks (the binary is not PATH-resolved, the
      // output is validated, and the floor refuses a shrink) but it is NOT closed, so it is
      // written down instead of claimed shut.
      timeout: MEMBERSHIP_TIMEOUT_MS,
      maxBuffer: MEMBERSHIP_MAX_BYTES,
    });
  } catch (e) {
    // EVERY failure mode lands here and EVERY one of them refuses. `evidence-first-claims.md`
    // MUST-3: an errored command is ZERO evidence, never confirmation — and the one thing it
    // must never be read as is "the snapshot still holds".
    const why =
      e && e.killed && e.signal
        ? `it was killed by ${e.signal} (the ${MEMBERSHIP_TIMEOUT_MS} ms bound)`
        : e && typeof e.status === "number"
          ? `it exited ${e.status}`
          : `it could not be spawned (${(e && e.code) || (e && e.message) || "unknown"})`;
    refuse(
      `source '${rel}' declares a LIVE membership query and ${why}. There is NO fallback to the ` +
        `frozen snapshot: falling back would reinstate the stale-count defect a live source exists to ` +
        `close, at exactly the moment the live surface became unreadable. An unanswered query is ` +
        `UNRUNNABLE, never a pass.` +
        (e && e.stderr ? `\n  the query's stderr: ${safeCell(String(e.stderr).trim().slice(0, 400))}` : ""),
    );
  }
  const ids = [];
  const records = [];
  const seen = new Set();
  for (const rawLine of out.split("\n")) {
    if (rawLine.trim() === "") continue;
    let id = rawLine.trim();
    let state = null;
    let ref = null;
    if (recordMode) {
      // EXACTLY three fields. Two is a query that emitted no ref, four is a ref
      // carrying a tab; both are refused by NUMBER rather than by best-effort
      // reassembly, because reassembling would let a malformed line become a
      // plausible member.
      const parts = rawLine.replace(/\r$/, "").split("\t");
      if (parts.length !== 3) {
        refuse(
          `source '${rel}': the membership query emitted a line with ${parts.length} tab-separated ` +
            `field(s), expected exactly 3 (id, state, record_ref): ` +
            `'${safeCell(rawLine.slice(0, 120))}'. A projected member with no state has no derivable ` +
            `status, and one with no record reference resolves to NO SOURCE RECORD — neither may be ` +
            `guessed at, so the build refuses rather than counting a member it cannot place or link.`,
        );
      }
      id = parts[0].trim();
      state = parts[1].trim();
      ref = parts[2].trim();
      if (id === "") {
        refuse(`source '${rel}': the membership query emitted a line whose id field is EMPTY`);
      }
      if (state === "") {
        refuse(
          `source '${rel}': the membership query emitted member '${safeCell(id)}' with an EMPTY state ` +
            `field. Status is DERIVED from the source record; an empty state is an unanswered question, ` +
            `never a default.`,
        );
      }
      if (/[\s\u0000-\u001F\u007F]/.test(state)) {
        refuse(
          `source '${rel}': member '${safeCell(id)}' carries state ` +
            `'${safeCell(state.slice(0, 60))}', which contains whitespace or a control character. A state ` +
            `is a KEY into the declared status_derivation.map, so it must be a bare token.`,
        );
      }
      if (ref === "" || ref.length > MAX_REF_CHARS || /[\s\u0000-\u001F\u007F]/.test(ref)) {
        refuse(
          `source '${rel}': member '${safeCell(id)}' carries record_ref ` +
            `'${safeCell(ref.slice(0, 80))}' (${ref.length} chars), which is empty, over the ` +
            `${MAX_REF_CHARS}-character bound, or carries whitespace/a control character. LINK-S requires ` +
            `every projected member to resolve to a SOURCE RECORD; an unusable reference resolves to none.`,
        );
      }
    }
    // Whitespace or a C0/DEL control byte. The HYPHEN is deliberately NOT in this class:
    // every id convention here is `PREFIX-slug`, so a class of `\s`, space and HYPHEN would
    // reject every well-formed id while looking correct.
    if (/[\s\u0000-\u001F\u007F]/.test(id)) {
      refuse(
        `source '${rel}': the live membership query emitted '${safeCell(id.slice(0, 60))}', which carries ` +
          `whitespace or a control character. An id is a JOIN KEY; one that is not a bare token cannot be ` +
          `matched against a tracker row or grepped out of a context artifact.`,
      );
    }
    if (id.length < MIN_ID_LEN) {
      refuse(
        `source '${rel}': the live membership query emitted id '${safeCell(id)}' (${id.length} chars), below ` +
          `the ${MIN_ID_LEN}-character join-key floor. A short id substring-matches essentially any prose, ` +
          `so the traceability chain would certify a link it never established.`,
      );
    }
    if (seen.has(id)) {
      refuse(
        `source '${rel}': the live membership query emitted id '${safeCell(id)}' twice. A duplicate means ` +
          `the query is wrong about its own population, and this tool will not guess which reading was meant.`,
      );
    }
    seen.add(id);
    ids.push(id);
    if (recordMode) records.push({ id, state, ref });
  }
  // THE FLOOR IS DERIVED, and the measurement is banked whether or not it moved.
  //
  // `--reground` suspends the REFUSAL and nothing else: the measurement below is still
  // taken, still from the same query output, and is what gets written. So the operator
  // cannot re-ground to a number they typed — only to a number this query returned.
  // That is the whole difference between this and the hand-typed floor it replaces.
  // SUSPENDED PER SUBJECT, never globally. Re-grounding source A must not carry source
  // B past its own floor in the same run — B's collapse is exactly what the gate exists
  // to catch, and a blanket suspension is how it was carried through unexamined.
  if (REGROUND_SUBJECT !== rel) {
    checkAgainstDerivedFloor(
      FLOORS,
      rel,
      ids.length,
      `source '${rel}': the live membership query`,
    );
  }
  MEASURED.push({ subject: rel, members: ids.length });
  return recordMode ? records : ids;
}

/**
 * A pointer that addresses NOTHING is distinguishable from one addressing `null`.
 * `undefined` cannot carry that distinction — a JSON value may legitimately be `null`,
 * and reading a miss as `null` would let a ref that no longer addresses a record pass
 * exactly where it must refuse. So a miss is its own sentinel.
 */
const POINTER_MISS = Symbol("json-pointer-miss");

/**
 * RFC 6901 JSON Pointer, resolved STRICTLY.
 *
 * `hasOwnProperty` rather than `in` or a bare index: `/__proto__/constructor` resolves
 * through the prototype chain on every plain object, so a ref naming a record that does
 * not exist would resolve against the language rather than against the registry — LINK-S
 * passing for a record nobody wrote.
 */
function resolveJsonPointer(doc, pointer) {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return POINTER_MISS;
  let cur = doc;
  for (const rawTok of pointer.slice(1).split("/")) {
    // Unescape ~1 BEFORE ~0 (RFC 6901 section 4): the other order turns `~01` into `/`
    // instead of `~1`, so two different registry keys would address the same record.
    const tok = rawTok.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return POINTER_MISS;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(tok)) return POINTER_MISS;
      const i = Number(tok);
      if (i >= cur.length) return POINTER_MISS;
      cur = cur[i];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return POINTER_MISS;
      cur = cur[tok];
    }
  }
  return cur;
}

/**
 * Resolve a PROJECTED source: run its declared query, DERIVE each member's status from
 * the state that query reported, and check LINK-S for every member.
 *
 * Returns the same `{items, live, ...}` shape `resolveLiveSource` returns, so
 * `loadSources` and `resolveItems` need no knowledge of which live kind produced it —
 * except for the `cls` marker each item carries, which is what makes the class
 * enforceable downstream.
 *
 * NO STALENESS BOUND, and its ABSENCE is enforced rather than assumed.
 * `resolveLiveSource` needs `as_of` / `max_age_days` because it freezes an
 * ADJUDICATION that nothing re-derives. A projected source freezes NOTHING: both
 * membership and status come from the query on every build. A staleness bound here
 * would bound nothing while reading, to anyone scanning the manifest, as though an
 * adjudication were being aged — so declaring one REFUSES rather than being ignored.
 * That is the same disposition `loadSources` already takes on a `membership` block
 * attached to a non-live kind, for the same reason: a silently-inert declaration is
 * worse than a missing one, because its presence is what a later reader cites as proof.
 */
function resolveProjectedSource(repo, manifestRel, rel, doc, pages) {
  // ── the FORBIDDEN fields — a projected source adjudicates NOTHING ──────────
  if (!Array.isArray(doc.items) || doc.items.length > 0) {
    refuse(
      `source '${rel}' is kind 'projected' and declares ${Array.isArray(doc.items) ? doc.items.length : "a non-array"} ` +
        `item(s). A projected item's status is DERIVED from its source record on every build; a local ` +
        `items[] entry is a LOCAL ADJUDICATION of a population nobody adjudicates at this volume, which ` +
        `is exactly the defect this class exists to end. Declare 'items': [] and let the query answer.`,
    );
  }
  for (const key of ["original_ids", "arrival_defaults"]) {
    if (doc[key] !== undefined) {
      refuse(
        `source '${rel}' is kind 'projected' but declares '${key}', which belongs to 'live-growth'. Those ` +
          `two fields exist to FREEZE an adjudication and separate it from later arrivals; a projection ` +
          `freezes nothing, so the declaration would never run while reading as though it had.`,
      );
    }
  }
  const mem = doc.membership;
  if (!mem || typeof mem !== "object" || Array.isArray(mem)) {
    refuse(
      `source '${rel}' is kind 'projected' but carries no 'membership' object. A projection's whole ` +
        `contract is that a query RE-DERIVES it; without one it is a static snapshot wearing a live label.`,
    );
  }
  for (const key of ["as_of", "max_age_days"]) {
    if (mem[key] !== undefined) {
      refuse(
        `source '${rel}' declares membership.${key}, which a projected source may not carry. Those bound ` +
          `the age of a FROZEN adjudication, and a projection has none — status is re-derived on every ` +
          `build. A bound that bounds nothing reads as freshness discipline while providing none.`,
      );
    }
  }
  assertNoLegacyMinMembers(mem, rel);
  if (!Array.isArray(mem.command) || mem.command.length === 0 || !mem.command.every((c) => typeof c === "string" && c)) {
    refuse(
      `source '${rel}' declares membership.command ${JSON.stringify(mem.command)}; expected a non-empty ` +
        `ARRAY of non-empty strings. An argv array, never a string: a string would need a shell to split, ` +
        `and a shell turns a declared query into an injection surface.`,
    );
  }

  // ── the PAGE is a property of the SOURCE, not of the item ──────────────────
  // Every member of one projection sits on one page: the deferral registry's rows go on
  // the deferral page, the issue tracker's on the issues page. Declaring it per-source
  // is what removes the last per-item hand-adjudication; a per-item page would put one
  // back and would have to be typed by the same nobody.
  if (typeof doc.page !== "string" || !pages.includes(doc.page)) {
    refuse(
      `source '${rel}' declares page '${safeCell(String(doc.page))}', which is not in the manifest ` +
        `pages[] (${pages.join(", ")}). A projected source declares ONE page for its whole population.`,
    );
  }

  // ── the STATUS DERIVATION — a TRANSLATION, never an adjudication ───────────
  const sd = doc.status_derivation;
  if (!sd || typeof sd !== "object" || Array.isArray(sd) || !sd.map || typeof sd.map !== "object" || Array.isArray(sd.map)) {
    refuse(
      `source '${rel}' is kind 'projected' but declares no 'status_derivation.map' object. The map ` +
        `translates the SOURCE registry's own state vocabulary into this block's closed one. It is a ` +
        `translation table, reviewable in a diff, and it is the only place a projected status comes from.`,
    );
  }
  const map = new Map();
  for (const [state, status] of Object.entries(sd.map)) {
    if (!state) refuse(`source '${rel}': status_derivation.map carries an empty state key`);
    validateProjectedStatus(status, `source '${rel}' status_derivation.map['${safeCell(state)}']`);
    map.set(state, status);
  }
  if (map.size === 0) {
    refuse(
      `source '${rel}': status_derivation.map is EMPTY, so every member's state would be unmapped and the ` +
        `build would refuse on the first one. An empty map is a source that cannot produce a count.`,
    );
  }

  // ── LINK-S — the record-reference contract ─────────────────────────────────
  const rr = doc.record_ref;
  if (!rr || typeof rr !== "object" || Array.isArray(rr)) {
    refuse(
      `source '${rel}' is kind 'projected' but declares no 'record_ref' object. LINK-1/2/3 are REPLACED ` +
        `for this class, never waived: a projected item resolves to its SOURCE RECORD instead of to a ` +
        `tracker row and a hand-written value_anchor. Without this declaration nothing links at all.`,
    );
  }
  if (!REF_KINDS.includes(rr.kind)) {
    refuse(
      `source '${rel}' declares record_ref.kind '${safeCell(String(rr.kind))}'; expected one of ` +
        `${REF_KINDS.join(", ")}. The kind is DECLARED and never sniffed from a ref's shape: sniffing ` +
        `would let a malformed in-repo path fall through to the weaker external check and pass.`,
    );
  }
  if (typeof rr.pattern !== "string" || !rr.pattern || rr.pattern.length > MAX_REF_PATTERN_CHARS) {
    refuse(
      `source '${rel}' declares record_ref.pattern ${JSON.stringify(rr.pattern)}; expected a non-empty ` +
        `string of at most ${MAX_REF_PATTERN_CHARS} characters. The pattern is what makes LINK-S ` +
        `FALSIFIABLE — it is declared by the SOURCE and not chosen by the query, so a query that ` +
        `half-failed emits a ref the pattern rejects.`,
    );
  }
  let refRx;
  try {
    refRx = new RegExp(rr.pattern);
  } catch (e) {
    refuse(`source '${rel}': record_ref.pattern is not a valid regular expression (${e.message})`);
  }

  // ── run the query ─────────────────────────────────────────────────────────
  const recs = runMembershipQuery(repo, manifestRel, rel, mem, true);

  const items = [];
  const seenRef = new Map();
  const stateCounts = new Map();
  for (const r of recs) {
    if (!map.has(r.state)) {
      refuse(
        `source '${rel}': member '${safeCell(r.id)}' reports state '${safeCell(r.state)}', which the ` +
          `declared status_derivation.map does not translate (it knows: ${[...map.keys()].map(safeCell).join(", ")}). ` +
          `There is NO default and there will not be one: a default is what lets an unrecognised registry ` +
          `state land in whichever bucket the code happened to pick, silently, for the whole population. ` +
          `Add the state to the map — a reviewable diff — or fix the query.`,
      );
    }
    if (!refRx.test(r.ref)) {
      refuse(
        `source '${rel}': member '${safeCell(r.id)}' carries record_ref '${safeCell(r.ref.slice(0, 120))}', ` +
          `which does not match the declared record_ref.pattern. LINK-S is UNRESOLVED for it, so it ` +
          `resolves to NO SOURCE RECORD and the build refuses rather than counting an item a reader ` +
          `cannot follow.`,
      );
    }
    const prior = seenRef.get(r.ref);
    if (prior !== undefined) {
      refuse(
        `source '${rel}': members '${safeCell(prior)}' and '${safeCell(r.id)}' both resolve to record_ref ` +
          `'${safeCell(r.ref.slice(0, 120))}'. Two items cannot BE the same source record: one of them is ` +
          `counted against a record that is not its own, which is a double-count of one registry row.`,
      );
    }
    seenRef.set(r.ref, r.id);
    if (rr.kind === "repo-path") {
      // DEREFERENCED, offline: the registry is a file in THIS repo, so LINK-S is a full
      // resolution rather than an addressability claim. Both halves are required —
      // TRACKED (an untracked registry makes the block unreproducible from the SHA it
      // records) and CARRYING THE ID VERBATIM (a tracked file that never mentions the id
      // is the stale-anchor failure the value_anchor mechanism has, reproduced).
      //
      // A ref MAY carry an RFC-6901 JSON POINTER after the first `#`, and for a registry
      // that keeps MANY records in ONE FILE it MUST. Uniqueness is checked over the WHOLE
      // ref above, so without a pointer every row of a single-file registry collides on
      // the file path and the class cannot express the very case its own documentation
      // names ("a deferral registry"). The alternative on offer was to declare such a
      // source `external` — shape and uniqueness, no dereference — which is choosing the
      // WEAKER check for the case where the STRONGER one is available offline.
      //
      // The pointer is RESOLVED, never shape-checked: the file must parse as JSON and the
      // pointer must address an existing value. That is strictly stronger than the
      // id-substring check it replaces for this shape — a substring matches prose anywhere
      // in the file, while a pointer to a record that was deleted refuses.
      const hashAt = r.ref.indexOf("#");
      const refPath = hashAt === -1 ? r.ref : r.ref.slice(0, hashAt);
      const pointer = hashAt === -1 ? null : r.ref.slice(hashAt + 1);
      if (pointer === "") {
        refuse(
          `source '${rel}': member '${safeCell(r.id)}' carries record_ref '${safeCell(r.ref.slice(0, 120))}', ` +
            `whose '#' introduces an EMPTY pointer. An empty fragment addresses the whole document, which ` +
            `every member of a single-file registry would satisfy identically — LINK-S would pass for all ` +
            `of them and discriminate none. Write the pointer or drop the '#'.`,
        );
      }
      const refRel = assertRepoRelative(manifestRel, `source '${rel}' member '${r.id}' record_ref`, refPath);
      // A SYMLINK IS REFUSED, on the same reasoning `assertCommittedAndUnmodified`
      // records for a declared source: `assertRepoRelative` is a STRING check and
      // closes the `..` half, while a symlink is a property of the FILESYSTEM that no
      // amount of string checking can see. git stores the LINK TEXT as the blob while
      // `readFileSync` follows it to the TARGET, so a tracked symlink pointing outside
      // the tree would let an out-of-tree file satisfy LINK-S and would read its bytes
      // (`security.md` § Path Containment). The mode is read from the index rather than
      // `lstat` so the answer comes from the same place `ls-files` answered from.
      const refMode = (git(repo, ["ls-files", "-s", "--", refRel]).match(/^(\d{6})\s/) || [])[1];
      if (refMode === "120000") {
        refuse(
          `source '${rel}': member '${safeCell(r.id)}' points at '${safeCell(refRel)}', which is a SYMLINK. ` +
            `A record reference is DEREFERENCED here, and a link is resolved to a target that may sit ` +
            `outside the tree entirely — so the id could be satisfied by a file this repo does not carry.`,
        );
      }
      if (git(repo, ["ls-files", "--", refRel]) !== refRel) {
        refuse(
          `source '${rel}': member '${safeCell(r.id)}' resolves to record_ref '${safeCell(refRel)}', which ` +
            `is NOT TRACKED at HEAD. A repo-path reference is DEREFERENCED, not merely shape-checked, so an ` +
            `untracked target is an unresolved LINK-S.`,
        );
      }
      let body;
      try {
        body = fs.readFileSync(path.join(repo, refRel), "utf8");
      } catch (e) {
        refuse(
          `source '${rel}': member '${safeCell(r.id)}' record_ref '${safeCell(refRel)}' could not be read ` +
            `(${e.code || e.message}). An unreadable source record is an UNANSWERED link, never a passing one.`,
        );
      }
      if (pointer === null) {
        if (!body.includes(r.id)) {
          refuse(
            `source '${rel}': member '${safeCell(r.id)}' points at '${safeCell(refRel)}', which does not carry ` +
              `that id verbatim. The reference resolves to a FILE but not to a RECORD, which is the ` +
              `stale-pointer failure LINK-S exists to make impossible.`,
          );
        }
      } else {
        let parsedRec;
        try {
          parsedRec = JSON.parse(body);
        } catch (e) {
          refuse(
            `source '${rel}': member '${safeCell(r.id)}' carries a JSON-pointer record_ref into ` +
              `'${safeCell(refRel)}', which does not parse as JSON (${e.message.slice(0, 120)}). A pointer ` +
              `into a document that cannot be parsed resolves to nothing, and nothing is not a record.`,
          );
        }
        if (resolveJsonPointer(parsedRec, pointer) === POINTER_MISS) {
          refuse(
            `source '${rel}': member '${safeCell(r.id)}' points at '${safeCell(refRel)}' with JSON pointer ` +
              `'${safeCell(pointer.slice(0, 120))}', which addresses NO value in that document. The reference ` +
              `resolves to a FILE but not to a RECORD, which is the stale-pointer failure LINK-S exists to ` +
              `make impossible.`,
          );
        }
      }
    }
    stateCounts.set(r.state, (stateCounts.get(r.state) || 0) + 1);
    items.push({ id: r.id, page: doc.page, status: map.get(r.state), cls: "projected" });
  }

  // DETERMINISTIC ORDER. The query's emission order is the registry's, which is not
  // stable across runs; sorting here means re-running the same query with the rows
  // shuffled cannot move a byte of output.
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sorted = [...recs].sort((a, b) => (a.id < b.id ? -1 : 1));
  // Read AFTER the query has run, so `--json` reports the record the gate was actually
  // judged against rather than one read at a different moment.
  const floorRec = floorRecordFor(FLOORS, rel);
  return {
    items,
    live: items.map((i) => i.id),
    // MEMBERSHIP ONLY — and this REVERSES a decision taken earlier in this same
    // change, so the reasoning is recorded rather than quietly swapped.
    //
    // The first version folded each member's DERIVED STATUS and record ref in here,
    // on the argument that a projection's status can move with the population
    // unchanged and a membership-only digest would call that block current. That
    // argument was correct while the derived status still fed an adjudication bucket.
    // It is FALSE under separate denominators: a projected item reports MEMBERSHIP and
    // nothing else, so its registry state moves NO COUNT IN THIS BLOCK.
    //
    // Keeping it would have been actively harmful rather than merely redundant. The
    // digest is rendered into the block AND hashed into every token, so a registry
    // state flip that changes no count would still change the digest and rewrite all
    // ~100 tokens — invalidating every outstanding QUOTE for nothing, since
    // `--verify-quote` re-hashes a token against this digest. A figure that stops
    // validating when nothing observable moved is a figure people learn to distrust.
    //
    // What the digest must track is the SUBJECT OF THE BLOCK, and for a projected
    // source that subject is exactly its membership.
    digestInput: sorted.map((r) => r.id).join("\n"),
    projected: true,
    refKind: rr.kind,
    page: doc.page,
    derivedFloor: floorRec.prior === null ? null : deriveFloor(floorRec.prior, FLOORS.frac),
    observedMembers: floorRec.prior,
    observedAt: floorRec.at,
    maxDropFraction: FLOORS.frac,
    stateCounts: [...stateCounts.entries()].sort().map(([state, count]) => ({ state, count, status: map.get(state) })),
    // A projection has no frozen set, so these are structurally absent rather than
    // zero. `--json` branches on `projected` and never prints a 0 that would read as
    // "nothing drained" when the honest answer is "there is no freeze to drain from".
    drained: null,
    arrived: null,
    asOf: null,
    originalCount: null,
  };
}

/**
 * Fold a live source's FROZEN adjudication together with its LIVE membership into the
 * effective item list `resolveItems` consumes.
 *
 * Returns `{ items, live, drained, arrived }`. `items` is ordered deterministically —
 * declared order for surviving originals, then arrivals sorted — so re-running the same
 * query with the rows in a different order cannot move a single byte of output.
 */
function resolveLiveSource(repo, manifestRel, rel, doc, pages) {
  const mem = doc.membership;
  if (!mem || typeof mem !== "object" || Array.isArray(mem)) {
    refuse(
      `source '${rel}' declares a LIVE kind but carries no 'membership' object. A live source's whole ` +
        `contract is that something RE-DERIVES it; without a query it is a static snapshot wearing a ` +
        `live label, which is strictly worse than an honest snapshot because it reads as fresh.`,
    );
  }

  // ── the staleness bound, checked BEFORE the query runs ────────────────────
  // A stale DECLARATION refuses whatever the query would have said. Membership is live;
  // the ADJUDICATION attached to `original_ids` — every page and status in `items[]` — is
  // a reading someone took on `as_of`, and nothing re-derives THAT. Without a bound, a
  // frozen judgement is indistinguishable from a fresh one, which is the second half of
  // the defect this closes.
  if (!isRealIsoDate(mem.as_of)) {
    refuse(
      `source '${rel}' declares membership.as_of '${safeCell(String(mem.as_of))}', which is not a real ` +
        `YYYY-MM-DD date. A live source MUST state when its frozen adjudication was taken.`,
    );
  }
  if (!Number.isInteger(mem.max_age_days) || mem.max_age_days < 1) {
    refuse(
      `source '${rel}' declares membership.max_age_days ${JSON.stringify(mem.max_age_days)}; expected an ` +
        `integer >= 1. An unbounded staleness allowance is permanent by default — the condition ` +
        `'every deferral carries a DATED declaration' exists to prevent.`,
    );
  }
  const today = todayIso();
  const age = daysBetween(mem.as_of, today);
  if (age < 0) {
    refuse(
      `source '${rel}' declares membership.as_of ${mem.as_of}, which is in the FUTURE (today is ${today}). ` +
        `A future as_of disables the staleness bound for as long as it is future — it is the one edit that ` +
        `switches this gate off while leaving every field populated.`,
    );
  }
  if (age > mem.max_age_days) {
    refuse(
      `source '${rel}' is STALE: its frozen adjudication was taken ${age} day(s) ago on ${mem.as_of} ` +
        `(today is ${today}) and it declares a bound of ${mem.max_age_days} day(s). Membership is ` +
        `re-derived on every build, but the page and status attached to each frozen id are NOT — they are ` +
        `a reading someone took on as_of, and past the bound this tool will not restate them as current. ` +
        `Re-adjudicate the items, then move membership.as_of in the same commit.`,
    );
  }

  assertNoLegacyMinMembers(mem, rel);
  if (!Array.isArray(mem.command) || mem.command.length === 0 || !mem.command.every((c) => typeof c === "string" && c)) {
    refuse(
      `source '${rel}' declares membership.command ${JSON.stringify(mem.command)}; expected a non-empty ` +
        `ARRAY of non-empty strings. An argv array, never a string: a string would need a shell to split, ` +
        `and a shell turns a declared query into an injection surface.`,
    );
  }

  // ── the FROZEN half ───────────────────────────────────────────────────────
  if (!Array.isArray(doc.original_ids)) {
    refuse(
      `source '${rel}' declares a LIVE kind but has no original_ids[] array. That set is the ONLY thing a ` +
        `live source is allowed to freeze — it is what separates 'was in the original ask' from 'arrived ` +
        `since', which is the split burndown-integrity.md MUST-3 protects.`,
    );
  }
  const original = new Set();
  for (const id of doc.original_ids) {
    if (typeof id !== "string" || !id) refuse(`source '${rel}': original_ids contains a non-string or empty id`);
    if (original.has(id)) refuse(`source '${rel}': original_ids declares '${safeCell(id)}' more than once`);
    original.add(id);
  }
  const ad = doc.arrival_defaults;
  if (!ad || typeof ad !== "object" || Array.isArray(ad)) {
    refuse(
      `source '${rel}' declares a LIVE kind but no arrival_defaults{page,status}. An item that arrived ` +
        `after the freeze has NO adjudication by definition, so the source must state what an un-adjudicated ` +
        `arrival counts as — leaving it implicit is how an arrival silently lands in whichever bucket the ` +
        `code happened to default to.`,
    );
  }
  if (typeof ad.page !== "string" || !pages.includes(ad.page)) {
    refuse(
      `source '${rel}': arrival_defaults.page '${safeCell(String(ad.page))}' is not declared in the ` +
        `manifest pages[] (${pages.join(", ")})`,
    );
  }
  validateStatus(ad.status, `source '${rel}' arrival_defaults`);

  const declared = new Map();
  for (const it of doc.items) {
    if (!it || typeof it.id !== "string" || !it.id) refuse(`source '${rel}': an item has no id`);
    if (!original.has(it.id)) {
      refuse(
        `source '${rel}' declares item '${safeCell(it.id)}' which is NOT in original_ids. On a live source ` +
          `items[] is the ADJUDICATION of the frozen set and nothing else; an item outside that set is ` +
          `either a frozen member nobody declared frozen, or an arrival being hand-adjudicated past the ` +
          `live query — and those are opposite mistakes with the same shape.`,
      );
    }
    if (declared.has(it.id)) refuse(`source '${rel}' declares item '${safeCell(it.id)}' more than once`);
    declared.set(it.id, it);
  }

  // ── the LIVE half ─────────────────────────────────────────────────────────
  const live = runMembershipQuery(repo, manifestRel, rel, mem);
  const liveSet = new Set(live);

  const items = [];
  for (const id of doc.original_ids) {
    if (!liveSet.has(id)) continue; // DRAINED — it drops out. That is the point.
    const it = declared.get(id);
    if (!it) {
      refuse(
        `source '${rel}': '${safeCell(id)}' is in original_ids and is STILL LIVE, but items[] carries no ` +
          `page or status for it. A live member with no adjudication has no page to be counted on.`,
      );
    }
    items.push(it);
  }
  const arrived = live.filter((id) => !original.has(id)).sort();
  for (const id of arrived) items.push({ id, page: ad.page, status: ad.status });

  const drained = doc.original_ids.filter((id) => !liveSet.has(id));
  const sortedLive = [...live].sort();
  return {
    items,
    live: sortedLive,
    // BYTE-IDENTICAL to what `sourcesDigest` computed inline before `projected` existed
    // (`s.live.live.join("\n")` over this same sorted array), so every block already
    // generated from a `live-growth` source keeps its digest and every token it issued
    // stays valid. The field exists so the digest input becomes a property each live
    // KIND declares, rather than one shape the digest function assumes of all of them.
    digestInput: sortedLive.join("\n"),
    projected: false,
    drained,
    arrived,
    asOf: mem.as_of,
    originalCount: doc.original_ids.length,
  };
}

function loadSources(repo, manifestRel, manifest) {
  const manifestDir = path.dirname(manifestRel) === "." ? "" : path.dirname(manifestRel);
  // SET UNCONDITIONALLY, and on every call. The selftest builds many repos in one
  // process; a lazily-initialised global would let repo B's membership be judged against
  // repo A's floors and report a plausible pass. Reset here rather than in `build()`
  // because this is the one function that populates them.
  FLOORS = loadFloors(repo, manifestRel, manifest);
  MEASURED = [];
  const out = [];
  const seenPaths = new Set();
  for (const entry of manifest.sources) {
    if (!entry || typeof entry.path !== "string") refuse(`manifest source entry missing 'path'`);
    if (!KINDS.has(entry.kind)) {
      refuse(`source '${entry.path}' declares kind '${entry.kind}'; expected one of ${[...KINDS].join(", ")}`);
    }
    // Held to the SAME shape as tracker.path / inventory.path. It was held to none:
    // a `"../shared/register.json"` under a subdirectory manifest read one path while
    // the anchor_roots self-input floor tested another, re-opening the tautology.
    const srcPath = assertRepoRelative(manifestRel, `source '${entry.path}'`, entry.path);
    const rel = manifestDir ? path.posix.join(manifestDir, srcPath) : srcPath;
    if (seenPaths.has(rel)) refuse(`source '${rel}' is declared twice in the manifest`);
    seenPaths.add(rel);
    // A declared precedence that is not an integer is REFUSED, never read as 0.
    // Silently coercing `"5"` to 0 changes which source wins and so changes the
    // COUNT — a wrong number produced from a manifest that plainly states the
    // opposite intent. That is the moving denominator re-entering through the
    // manifest, which is the one thing this generator exists to make impossible.
    if (entry.precedence !== undefined && !Number.isInteger(entry.precedence)) {
      refuse(
        `source '${rel}' declares precedence ${JSON.stringify(entry.precedence)}, which is not an integer. ` +
          `It would otherwise be read as 0, silently changing which source wins.`,
      );
    }
    assertCommittedAndUnmodified(repo, rel);

    const doc = readJson(path.join(repo, rel), "source", rel);
    if (typeof doc._generated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(doc._generated)) {
      refuse(`source '${rel}' has no valid _generated date (YYYY-MM-DD); precedence is undecidable without it`);
    }
    if (doc._authority !== "owner" && doc._authority !== "agent") {
      refuse(`source '${rel}' declares _authority '${doc._authority}'; expected 'owner' or 'agent'`);
    }
    if (!Array.isArray(doc.items)) refuse(`source '${rel}' has no items[] array`);

    // A liveness declaration on a kind that is not live is REFUSED, never ignored.
    // Same failure shape as the `status-refresh` carrying a `page`: the operator's
    // declaration reads as accepted, nothing runs, and the counts come back plausible
    // and frozen. A silently-dropped `membership` block is the WORST outcome available
    // here, because its presence is what a later reader would cite as proof the source
    // is live.
    if (!LIVE_KINDS.has(entry.kind)) {
      for (const key of ["membership", "original_ids", "arrival_defaults"]) {
        if (doc[key] !== undefined) {
          refuse(
            `source '${rel}' declares '${key}' but its kind is '${entry.kind}', which is not live ` +
              `(live kinds: ${[...LIVE_KINDS].join(", ")}). The declaration would never run, and a source ` +
              `carrying an inert liveness block reads as live to every reader of the manifest.`,
          );
        }
      }
    }
    // THE SAME FENCE, POINTED THE OTHER WAY. `page`, `status_derivation` and
    // `record_ref` are the PROJECTED class's fields; on any other kind they would never
    // run. The asymmetry of leaving this out is the failure the block above already
    // records: an inert declaration reads as live to every reader of the manifest, and
    // `record_ref` on a `growth` source would read as though LINK-S were being checked
    // when nothing checks it. Refused rather than ignored, in both directions.
    if (!PROJECTED_KINDS.has(entry.kind)) {
      for (const key of ["page", "status_derivation", "record_ref"]) {
        if (doc[key] !== undefined) {
          refuse(
            `source '${rel}' declares '${key}' but its kind is '${entry.kind}', which is not projected ` +
              `(projected kinds: ${[...PROJECTED_KINDS].join(", ")}). The declaration would never run, and ` +
              `a source carrying an inert 'record_ref' reads as though LINK-S were being checked for it.`,
          );
        }
      }
    }

    const live = PROJECTED_KINDS.has(entry.kind)
      ? resolveProjectedSource(repo, manifestRel, rel, doc, manifest.pages)
      : LIVE_KINDS.has(entry.kind)
        ? resolveLiveSource(repo, manifestRel, rel, doc, manifest.pages)
        : null;

    out.push({
      rel,
      kind: entry.kind,
      date: doc._generated,
      authority: doc._authority,
      precedence: entry.precedence === undefined ? 0 : entry.precedence,
      // A live source's items are its LIVE MEMBERSHIP, folded against the frozen
      // adjudication. `resolveItems` is handed the same shape either way and needs no
      // knowledge of liveness — its origin rule (first source to introduce an id) is
      // extended by what it is fed, not replaced.
      items: live ? live.items : doc.items,
      live,
      blob: blobSha(repo, rel),
    });
  }
  return out;
}

// ── precedence ──────────────────────────────────────────────────────────────
// (date, authority, precedence, PATH). Owner outranks a same-day agent refresh.
// Sorted ASCENDING so a later record overwrites an earlier one.
//
// THE FINAL KEY IS THE FULL RELATIVE PATH, AND THAT IS LOAD-BEARING. The ordering
// must be TOTAL: if two distinct sources can compare equal, `Array.sort` falls
// back to its own stability and ARRAY POSITION decides the count — the exact
// property this file claims it does not have. `rel` is unique by construction
// (`loadSources` refuses a duplicate path), so no two distinct sources compare 0
// and reordering the manifest cannot move a single count.
//
// It was `path.basename(rel)` before, which is NOT unique: `burndown/x/reg.json`
// and `burndown/y/reg.json` both reduce to `reg.json`, compared equal, and
// reversing the manifest array flipped `Signed off` between 0 and 1 on a
// one-item fixture. Pinned by `manifest-source-REORDER-*-same-basename`.
function byPrecedence(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.authority !== b.authority) return a.authority === "agent" ? -1 : 1;
  if (a.precedence !== b.precedence) return a.precedence - b.precedence;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

function validateStatus(status, where) {
  if (typeof status !== "string") refuse(`${where}: status is missing`);
  if (BLOCKED_LABELS.includes(status.trim().toLowerCase())) {
    refuse(
      `${where}: status '${status}' is a BLOCKED label. ` +
        `'${BLOCKED_LABELS.join("', '")}' each named at least two different buckets in prior reports; ` +
        `use one of: ${ASSIGNABLE.join(", ")}.`,
    );
  }
  if (!ASSIGNABLE.includes(status)) {
    refuse(`${where}: status '${status}' is outside the closed vocabulary (${ASSIGNABLE.join(", ")})`);
  }
}

/**
 * The closed vocabulary MINUS `Signed off`, for the projected class.
 *
 * NOT a new vocabulary and NOT a new value: `burndown-integrity.md`'s set is CLOSED
 * and stays closed. This narrows the ASSIGNABLE set for one item class, which is a
 * different act from widening it.
 *
 * WHY `Signed off` SPECIFICALLY. It means the OWNER walked the item and accepted it,
 * and it is the ONLY status counting toward completion (MUST-4). A projection derives
 * its status from an external registry's own state — and no state of GitHub's or of
 * `phase2-deferrals.json` is evidence that the owner accepted anything. Permitting it
 * would let an agent mark the owner's work accepted on their behalf, at volume, by
 * editing one map entry.
 *
 * `Open` needs no special handling and gets none: it is DERIVED (`total − Signed off`),
 * so a class that can never be `Signed off` is a class that is always `Open`. That is
 * the right answer arrived at by the existing arithmetic rather than by a new column.
 */
function validateProjectedStatus(status, where) {
  validateStatus(status, where);
  if (status === "Signed off") {
    refuse(
      `${where}: 'Signed off' is UNREACHABLE for a projected item. It means the OWNER walked and ` +
        `accepted the item, and it is the only status counting toward completion — so it is the one ` +
        `value a PROJECTION of an external registry may never derive. No state of that registry is ` +
        `evidence the owner accepted anything. If the owner HAS accepted it, the item belongs in a ` +
        `register or growth source they authored, not in a projection.`,
    );
  }
}

/**
 * Fold the declared sources into one item map. `origin` is decided by the FIRST
 * source that introduces an id: a register source makes it `register`, anything
 * else makes it `arrived-since`. That is what feeds the growth split — the column
 * most likely to be dropped in a port, and the one without which a page that is
 * nearly finished on what was FIRST asked reads as a regression.
 *
 * A LIVE SOURCE CHANGES NOTHING HERE, deliberately. By the time its items reach this
 * function they are already its LIVE MEMBERSHIP folded against its frozen adjudication
 * (`resolveLiveSource`) — drained ids are simply absent, arrivals are simply present.
 * So the origin rule below is EXTENDED by what it is fed rather than rewritten, and the
 * split keeps meaning what it always meant: an id first introduced by the register is
 * `from the original register`, and an id that reached the board any other way is
 * `arrived since`.
 */
function resolveItems(sources, pages) {
  const pageSet = new Set(pages);
  const items = new Map();
  for (const src of [...sources].sort(byPrecedence)) {
    for (const it of src.items) {
      if (!it || typeof it.id !== "string" || !it.id) refuse(`source '${src.rel}': an item has no id`);
      const where = `source '${src.rel}' item '${it.id}'`;
      const existing = items.get(it.id);

      // ── THE CLASS FENCE — an id belongs to ONE class, and it is not negotiable ──
      //
      // Order-INDEPENDENT by construction, which is why it is a collision test rather
      // than a precedence rule. `byPrecedence` decides which source WINS; if this were
      // expressed as "a projected source may not overwrite", then changing a source's
      // `_generated` date would decide whether the fence fired, and the fence would be a
      // function of the calendar. Refusing the COLLISION in both directions means no
      // ordering, date or authority reaches it.
      //
      // THIS IS WHERE `Signed off` BECOMES STRUCTURALLY IMPOSSIBLE rather than merely
      // unwritten. `validateProjectedStatus` closes the derivation path; this closes
      // every OTHER path to the same assignment — a `status-refresh` aimed at a
      // projected id, and a register or growth source re-declaring one. Without it an
      // agent could mark the owner's work accepted by adding two lines to a growth
      // source, and every count in the block would move.
      const projectedSrc = PROJECTED_KINDS.has(src.kind);
      if (existing && (existing.cls === "projected") !== projectedSrc) {
        refuse(
          `${where}: this id is already declared by '${existing.lastTouchedBy}' as ` +
            `${existing.cls === "projected" ? "PROJECTED" : "ADJUDICATED"}, and '${src.rel}' (kind ` +
            `'${src.kind}') declares it as ${projectedSrc ? "PROJECTED" : "ADJUDICATED"}. ` +
            `An id is in exactly ONE class: a PROJECTION of ` +
            `an external registry, whose status is derived from that registry and can never be 'Signed off', ` +
            `or an OWNER-adjudicated register item carrying the full LINK-1/2/3 chain. Letting the two ` +
            `overlap is how a projected item acquires a locally-assigned status — including the one that ` +
            `means the owner accepted it.`,
        );
      }

      if (src.kind === "status-refresh") {
        if (!existing) {
          refuse(
            `${where}: a status-refresh introduced an id that no register or growth source declares. ` +
              `Growth belongs in a growth source, where it is counted as 'arrived since'.`,
          );
        }
        validateStatus(it.status, where);
        // A refresh that carries a `page` is REFUSED rather than silently ignored.
        // It previously read as a no-op: the operator's declared move was dropped,
        // no error was raised, and the counts came back plausible and wrong for the
        // page they were reading. A refresh changes STATUS; a move belongs in the
        // register or growth source that owns the item's page.
        if (it.page !== undefined && it.page !== existing.page) {
          refuse(
            `${where}: a status-refresh declares page '${it.page}' but the item is on '${existing.page}'. ` +
              `A refresh cannot move an item between pages; change it in the register or growth source that declares it.`,
          );
        }
        existing.status = it.status;
        existing.lastTouchedBy = src.rel;
        continue;
      }

      // A projected item's status came from `validateProjectedStatus` inside
      // `resolveProjectedSource`, which is strictly narrower than this call. Running the
      // wider check here as well would be a second gate on the SAME path — a
      // defense-in-depth sibling that absorbs a mutation of either one and makes an
      // empty red-set unreadable (`instrument-discipline.md` MUST-5(b)). The narrow
      // check fires where the value is CREATED; the class fence above fires on every
      // other path that could reach it.
      if (!projectedSrc) validateStatus(it.status, where);
      if (typeof it.page !== "string" || !pageSet.has(it.page)) {
        refuse(`${where}: page '${it.page}' is not declared in the manifest pages[] (${pages.join(", ")})`);
      }
      if (existing) {
        existing.status = it.status;
        existing.page = it.page;
        existing.lastTouchedBy = src.rel;
      } else {
        items.set(it.id, {
          id: it.id,
          page: it.page,
          status: it.status,
          // UNTOUCHED, and that is the point. A projected source is not `register`, so
          // its members take `arrived-since` by the rule that was already here —
          // `burndown-integrity.md` MUST-3's split is preserved by NOT being special-cased.
          origin: src.kind === "register" ? "register" : "arrived-since",
          // ADJUDICATED is the default class: everything that is not a projection is an
          // item some person declared, carrying the full LINK-1/2/3 chain.
          cls: projectedSrc ? "projected" : "adjudicated",
          lastTouchedBy: src.rel,
        });
      }
    }
  }
  return items;
}

// ── tally ───────────────────────────────────────────────────────────────────
function emptyRow(name) {
  const r = { name };
  for (const [k] of COLUMNS) r[k] = 0;
  return r;
}

function tally(items, pages) {
  const rows = new Map(pages.map((p) => [p, emptyRow(p)]));
  for (const it of items.values()) {
    const row = rows.get(it.page);
    row.board += 1;
    if (it.cls === "projected") {
      // MEMBERSHIP ONLY. A projected item is counted, and it enters NO adjudication
      // bucket — not even as a zero. It is `Open` by construction, which needs no
      // special case: it can never be `Signed off`, and `Open` is derived.
      row.projected += 1;
    } else {
      row.adjudicated += 1;
      row[STATUS_KEY[it.status]] += 1;
    }
  }
  for (const [, row] of rows) {
    // `Open` is DERIVED against the ADJUDICATED denominator, which is what makes
    // completion reachable again: `Signed off` can equal `adjudicated`.
    row.open = row.adjudicated - row.signedOff;
    row.openBoth = row.open + row.projected;
  }
  // The split is counted over OPEN items only — a signed-off item is not open, so it
  // belongs to neither side of the growth split. It spans BOTH populations, because
  // an item that arrived since the freeze arrived whichever class it is in, and MUST-3
  // asks about arrival rather than about adjudication. Its denominator is `openBoth`
  // for exactly that reason.
  for (const it of items.values()) {
    if (it.cls !== "projected" && it.status === "Signed off") continue;
    const row = rows.get(it.page);
    if (it.origin === "register") row.openFromRegister += 1;
    else row.openArrivedSince += 1;
  }

  // (b) ALL PAGES is ARITHMETICALLY RE-DERIVED from the page rows and then
  // ASSERTED against them.
  //
  // SCOPE, stated exactly, because the claim here used to be wider than the code:
  // this is a TRIPWIRE ON THIS FUNCTION, not a check on any block that was written
  // out. `assertInvariants` only ever sees rows this process just computed, so NO
  // input can make it fire — `all` is the columnwise sum by construction. What it
  // does catch is a future edit to the accumulation below that stops it being that
  // sum (measured: adding `all.total += 1; all.signedOff += 1`, which preserves
  // every per-row invariant, refuses with exit 2 and no block).
  //
  // A HAND-EDITED BLOCK IS CAUGHT BY `--check`, WHICH COMPARES TEXT — not here.
  // The earlier comment claimed this re-derivation made a hand-edit "structurally
  // detectable", which would have sent a reader to the wrong mechanism.
  const all = emptyRow("ALL PAGES");
  for (const [, row] of rows) for (const [k] of COLUMNS) all[k] += row[k];

  const pageRows = [...rows.values()];
  assertInvariants(pageRows, all);
  return { pageRows, all };
}

function assertInvariants(pageRows, all) {
  for (const row of [...pageRows, all]) {
    // THE ADJUDICATION BUCKETS PARTITION THE ADJUDICATED POPULATION, not the board.
    // This is the invariant that broke under one denominator: with projected items in
    // `total`, the five buckets could never sum to it, so either the assertion had to
    // go or the projected items had to be given a bucket they do not occupy.
    const parts =
      row.signedOff + row.builtNotWalked + row.inProgress + row.notStarted + row.blockedOnYou;
    if (parts !== row.adjudicated) {
      refuse(
        `row '${row.name}' does not partition: adjudication buckets sum to ${parts} but the ADJUDICATED ` +
          `denominator is ${row.adjudicated}`,
      );
    }
    if (row.board !== row.adjudicated + row.projected) {
      refuse(
        `row '${row.name}': board is ${row.board} but adjudicated + projected is ` +
          `${row.adjudicated + row.projected}. Every item is in exactly one class.`,
      );
    }
    if (row.open !== row.adjudicated - row.signedOff) {
      refuse(
        `row '${row.name}': Open is ${row.open} but adjudicated − Signed off is ${row.adjudicated - row.signedOff}`,
      );
    }
    if (row.openBoth !== row.open + row.projected) {
      refuse(
        `row '${row.name}': 'Open: both populations' is ${row.openBoth} but adjudicated-Open + projected ` +
          `is ${row.open + row.projected}. A projected item is Open by construction — it can never be ` +
          `'Signed off', and Open is derived — so every one of them is in this figure.`,
      );
    }
    if (row.openFromRegister + row.openArrivedSince !== row.openBoth) {
      refuse(
        `row '${row.name}': growth split ${row.openFromRegister}+${row.openArrivedSince} does not sum to ` +
          `'Open: both populations' ${row.openBoth}`,
      );
    }
  }
  for (const [k, label] of COLUMNS) {
    const sum = pageRows.reduce((a, r) => a + r[k], 0);
    if (sum !== all[k]) {
      refuse(`ALL PAGES column '${label}' is ${all[k]} but the page rows sum to ${sum}`);
    }
  }
}

/**
 * THE CERTIFIED INDEX, READ BACK OUT OF THE COMMITTED BLOCK — the verification
 * path that does not rebuild the board.
 *
 * WHY THIS EXISTS. `--verify-quote` used to route through `build()`, like every
 * other mode, and `build()` is not affordable at the surface that needs it most.
 * MEASURED on this repo: a `--verify-quote` run costs ~6.1s wall (5775–6729ms
 * over five runs at 6b07b3d7), of which 4305ms is 229 subprocess spawns — 123
 * `git ls-files`, 35 `git diff --quiet`, 26 `git show`, a `gpgconf` fold, and a
 * `burndown-query-issues.mjs` that runs `gh issue list` against the NETWORK.
 * `hooks/lib/burndown-quote.js` spawns that under a 3000ms `spawnSync` timeout,
 * so the verifier timed out on EVERY invocation and returned its UNKNOWN third
 * state every time. The consequence is the one thing a verifier must never do:
 * its output was BYTE-IDENTICAL for a valid quote and a tampered one
 * (`{ran:false, unknown:"verifier did not complete (ETIMEDOUT)"}` for both), so
 * arm (1) — the only `block`-class structural arm in the whole rule — could not
 * fire, ever. That is `instrument-discipline.md` MUST-1: a check whose result
 * does not move with the proposition is not evidence, whatever it printed.
 *
 * A TIMEOUT BUMP WOULD NOT HAVE FIXED IT, and that is why the seam moved instead.
 * The digest every token hashes includes each PROJECTED source's live membership
 * (`sourcesDigest` → `s.live.digestInput`), and that membership comes from a
 * network query. So the cost is not slow code, it is an unbounded dependency: no
 * timeout is large enough to make a `gh` round-trip safe inside a Stop hook, and
 * a hook firing a GitHub API request per agent reply is its own defect.
 *
 * WHAT IT READS INSTEAD. `verifyQuotes` needs exactly two inputs — the token
 * index and the digest — and the committed block already carries both: every
 * cell is `value⟨token⟩` under a column whose header IS the bucket label, and the
 * block's own `sources_digest:` line is the digest those tokens were hashed with.
 * The block is therefore not a cache of the authority, it IS the authority: the
 * rule's own binding clause says "These are the only counts. Any figure quoted
 * anywhere is this block verbatim, or it is wrong." Deriving the verification
 * index from the block is that sentence executed. There is ONE artefact, so there
 * is nothing for a sidecar to drift from.
 *
 * THE PARSE IS SELF-VERIFYING, which is what makes reading a rendered table safe.
 * Every parsed cell is re-hashed from the identity the parse assigned it, and the
 * result MUST equal the token that cell printed. A mis-parse cannot produce a
 * consistent index, and neither can a hand-edited cell — so this path also
 * catches block tampering that the rebuild path only ever caught indirectly.
 * Any mismatch REFUSES (exit 2 → the hook's UNKNOWN); it never degrades to a
 * partial index, because a partial index validates the quotes it still holds and
 * reports the rest as unknown tokens, which is a wrong answer wearing the
 * grammar of a finding.
 *
 * SCOPE, STATED SO IT IS NOT OVER-READ (`instrument-discipline.md` MUST-4). This
 * answers "is this quote a faithful quote of the certified block?" — MUST-1's
 * question. It does NOT answer "is the block current with respect to its
 * sources?"; that is `--check`'s question, it needs the rebuild, and it is gated
 * in CI (`.github/workflows/coc-artifact-eval.yml` runs `--check` and fails the
 * build on a stale block). The two questions were previously conflated in one
 * instrument that answered NEITHER, because it never completed.
 *
 * Returns `{ idx, digest }` in exactly the shape `tokenIndex` returns, so
 * `verifyQuotes` and `quoteFor` cannot tell the two producers apart.
 */
function parseBlockIndex(blockText, sourceLabel) {
  const digest = (blockText.match(/^sources_digest: ([0-9a-f]{64})$/m) || [])[1];
  if (!digest) {
    refuse(
      `the burndown block in ${sourceLabel} carries no readable 'sources_digest:' line, so there is ` +
        `nothing to validate tokens against. Regenerate it with --write.`,
    );
  }

  const lines = blockText.split("\n");
  const wantHeader = `| page | ${COLUMNS.map(([, l]) => l).join(" | ")} |`;
  const headerAt = lines.findIndex((l) => l.trim() === wantHeader);
  if (headerAt === -1) {
    refuse(
      `the burndown block in ${sourceLabel} does not carry the expected column header, so its cells ` +
        `cannot be bound to buckets. Expected:\n  ${wantHeader}\n` +
        `This is what a block generated by an OLDER column set looks like. Regenerate with --write.`,
    );
  }

  const idx = new Map();
  idx.absentBuckets = new Map();
  // Row order is irrelevant to the index, so the rows are taken as they come and
  // the separator line is skipped by shape rather than by position.
  let rowsSeen = 0;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw.startsWith("|")) break; // the table ends where the pipes stop
    if (/^\|(\s*---\s*\|)+$/.test(raw)) continue;
    // Strip the leading and trailing pipe, then split. `**ALL PAGES**` and its
    // bolded cells are unwrapped here so the derived row parses identically to a
    // page row — the bold is presentation and is not part of any hashed field.
    const fields = raw
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((f) =>
        f
          .trim()
          .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
          .trim(),
      );
    if (fields.length !== COLUMNS.length + 1) {
      refuse(
        `the burndown block in ${sourceLabel} has a table row with ${fields.length} field(s) where ` +
          `${COLUMNS.length + 1} are expected: ${raw.slice(0, 120)}`,
      );
    }
    const rowName = fields[0];
    const cells = fields.slice(1);
    rowsSeen++;

    // Pass 1: the DENOMINATOR columns, which every other column's token hashes.
    // All three denKeys in COLUMNS (`board`, `adjudicated`, `openBoth`) name
    // columns whose own `absentWhenNoAdjudicated` is false, so each is always
    // rendered and this pass cannot come up empty for a row that has cells.
    const valueByKey = new Map();
    for (let c = 0; c < COLUMNS.length; c++) {
      const [key] = COLUMNS[c];
      const mm = cells[c].match(/^(\d+)⟨[0-9a-f]{6}⟩$/);
      if (mm) valueByKey.set(key, Number(mm[1]));
    }

    for (let c = 0; c < COLUMNS.length; c++) {
      const [key, label, denKey] = COLUMNS[c];
      const bucket = `${rowName}/${label}`;
      const cellText = cells[c];
      if (cellText === ABSENT_CELL) {
        // Same decision `tokenIndex` makes, carried across so `--quote` can say
        // "absent, and here is why" from either producer. `projected` is not
        // recoverable from the rendering and is deliberately not guessed.
        idx.absentBuckets.set(bucket, { row: rowName, label, projected: null });
        continue;
      }
      const mm = cellText.match(/^(\d+)⟨([0-9a-f]{6})⟩$/);
      if (!mm) {
        refuse(
          `the burndown block in ${sourceLabel} renders cell '${bucket}' as ${JSON.stringify(cellText)}, ` +
            `which is neither a '${ABSENT_CELL}' nor a 'value⟨token⟩' count. A cell that cannot be ` +
            `read cannot be verified against, and guessing one would validate quotes of a figure nobody ` +
            `certified. Regenerate with --write; do NOT hand-edit the table.`,
        );
      }
      const value = Number(mm[1]);
      const tok = mm[2];
      const denominator = valueByKey.get(denKey);
      if (denominator === undefined) {
        refuse(
          `cell '${bucket}' in ${sourceLabel} binds denominator column '${denKey}', which that row does ` +
            `not render as a count. The block's column set and this generator's disagree; regenerate with --write.`,
        );
      }

      // THE SELF-CHECK. Re-hash the identity the parse just assigned and require
      // the cell's own token back. This is what licenses reading a rendered table
      // as an index: a mis-parse assigns the wrong row, label or denominator and
      // the hash diverges, and a hand-edited value diverges too.
      const recomputed = tokenFor(bucket, denominator, value, digest);
      if (recomputed !== tok) {
        refuse(
          `the burndown block in ${sourceLabel} does not validate against itself: cell '${bucket}' ` +
            `renders ${value} of ${denominator} with token '${tok}', but that identity hashes to ` +
            `'${recomputed}' under sources_digest ${digest.slice(0, 12)}. Either the block was ` +
            `hand-edited or it was generated by a different column set. It is NOT usable as a ` +
            `verification authority — regenerate with '--write'. (This refusal is exit 2, an UNKNOWN, ` +
            `never a pass: no quote was checked.)`,
        );
      }

      const clash = idx.get(tok);
      if (clash && clash.bucket !== bucket) {
        refuse(
          `token collision in the committed block: '${bucket}' and '${clash.bucket}' both carry '${tok}'. ` +
            `A quote of either would certify the other. Widen TOKEN_LEN (currently ${TOKEN_LEN}) and regenerate.`,
        );
      }
      idx.set(tok, { bucket, denominator, value, row: rowName, label, denKey });
    }
  }

  if (rowsSeen === 0 || idx.size === 0) {
    refuse(
      `the burndown block in ${sourceLabel} carries no readable count cells (${rowsSeen} table row(s), ` +
        `${idx.size} token(s)). An empty index would report every quoted token as "not produced by the ` +
        `current block", which is a confident wrong answer rather than an absent one.`,
    );
  }
  return { idx, digest };
}

/**
 * Every count in the block, with its identity and its token.
 *
 * The DENOMINATOR is the row's own `total` — that is what makes a token an
 * IDENTITY rather than a decorated quantity. Two rows can both read `2`; they
 * carry different tokens because `2 of 3 Signed off on Alpha` and
 * `2 of 7 Signed off across ALL PAGES` are different facts.
 */
function tokenIndex({ pageRows, all }, digest) {
  const idx = new Map();
  // Buckets that EXIST but carry no count on this row, because the row has no
  // adjudicated population. Carried on the index so `--quote` can say "absent, and
  // here is why" rather than "no such bucket", which would send an operator hunting
  // for a typo in a name that is correct.
  idx.absentBuckets = new Map();
  for (const row of [...pageRows, all]) {
    for (const [k, label, denKey, absentWhenNoAdjudicated] of COLUMNS) {
      const bucket = `${row.name}/${label}`;
      if (absentWhenNoAdjudicated && row.adjudicated === 0) {
        idx.absentBuckets.set(bucket, { row: row.name, label, projected: row.projected });
        continue;
      }
      // THE DENOMINATOR IS PER-COLUMN, and that is the whole change. It used to be
      // `row.total` for every cell, which is what let one number stand for two
      // populations. The token hashes the denominator, so a figure computed against
      // `adjudicated` cannot validate a sentence claiming it against `board`.
      const tok = tokenFor(bucket, row[denKey], row[k], digest);
      // A token is TRUNCATED to 6 hex chars, so two DIFFERENT counts can collide.
      // Rare, not impossible: ~99 tokens on a 10-page burndown gives a birthday
      // probability near 0.03%. Silently overwriting would make one bucket's
      // correct quote validate against ANOTHER bucket's fact — a wrong count
      // wearing a valid token, which is the one output this scheme exists to make
      // impossible. So a collision REFUSES rather than resolving arbitrarily.
      const clash = idx.get(tok);
      if (clash && clash.bucket !== bucket) {
        refuse(
          `token collision: '${bucket}' and '${clash.bucket}' both hash to '${tok}'. ` +
            `Two different counts cannot share one token — a quote of either would certify the other. ` +
            `Widen TOKEN_LEN (currently ${TOKEN_LEN}) and regenerate.`,
        );
      }
      idx.set(tok, { bucket, denominator: row[denKey], value: row[k], row: row.name, label, denKey });
    }
  }
  return idx;
}

// ── render ──────────────────────────────────────────────────────────────────
// ── the promotion gap ───────────────────────────────────────────────────────
//
// WHY THIS EXISTS. Lane work now lands in `dev` continuously and for FREE (a push
// to `dev` fires no CI); `dev -> main` is a separate, deliberate promotion costing
// exactly one CI run. "Landed" therefore means "in dev" — and the honest cost of
// that directive is that work sitting in `dev` and not on `main` STOPS READING AS
// UNLANDED to every surface that measures landedness. The gap becomes invisible
// exactly where it used to be loud. This line is the counter that keeps it honest:
// the burndown re-measures it on every regeneration, so it is visible on every
// close-out.
//
// THE PREDICATE IS IMPORTED, NEVER RE-IMPLEMENTED. `hooks/lib/trunk-ref.js` is the
// one resolver every landedness surface reads; a second `git rev-list --count`
// here is the enforcement-surface-parity defect (`security.md` § Enforcement-Surface
// Parity) — one surface learns the new trunk, a sibling does not, and they come to
// disagree about what "landed" means. The DENOMINATOR below is a DIFFERENT quantity
// (the trunk's total reachable population, which the resolver does not expose and
// was never asked for), so reading it here duplicates no predicate.
//
// LAZY, for the reason `tryEventsLib` is lazy: this file is distributed on an
// explicit guarantee that it carries ZERO RELATIVE IMPORTS, and two fixture
// harnesses COPY THE BIN ALONE into a temporary `.claude/bin/`. A top-level import
// would make every mode die with a module-resolution error in any tree that has the
// generator and not the hooks. Absence is a TYPED UNKNOWN, never a zero.
const TRUNK_REF_LIB_REL = ".claude/hooks/lib/trunk-ref.js";

/** Load the trunk resolver, or return null. Absence is the caller's to interpret. */
function tryTrunkRefLib() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return requireCjs(path.join(here, "..", "hooks", "lib", "trunk-ref.js"));
  } catch {
    return null;
  }
}

/**
 * Capture a git read, or null. Mirrors `gitOk`'s asymmetry deliberately: the binary
 * and the env envelope are resolved OUTSIDE the `try`, so an unresolved git REFUSES
 * rather than collapsing into a null that reads exactly like "git answered nothing".
 */
function gitCaptureOrNull(repo, args) {
  const bin = gitBinary();
  const env = gitEnvLib().gitEnvForArgs(args);
  try {
    return execFileSync(bin, args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * THREE STATES, and collapsing any pair of them is the defect this shape prevents
 * (`probe-driven-verification.md` MUST-7 — UNRUNNABLE is not a verdict):
 *
 *   RESOLVED       a separate trunk exists and the gap was counted.
 *   NOT-APPLICABLE no separate trunk exists (`<remote>/dev` is absent, so the
 *                  resolver falls back to `<remote>/main` and trunk IS main). There
 *                  is no gap BY CONSTRUCTION — which is a DIFFERENT fact from a
 *                  trunk that exists and happens to be level, and renders differently.
 *   UNKNOWN        nothing measured it. NEVER rendered as 0.
 */
function measurePromotionGap(repo) {
  const lib = tryTrunkRefLib();
  if (!lib || typeof lib.promotionGap !== "function") {
    return {
      state: "UNKNOWN",
      why:
        `the shared trunk resolver '${TRUNK_REF_LIB_REL}' is not loadable from this tree, so NOTHING ` +
        `measured the gap`,
    };
  }
  let g;
  try {
    g = lib.promotionGap({ repoDir: repo });
  } catch (e) {
    return { state: "UNKNOWN", why: `the shared trunk resolver threw: ${safeCell(String((e && e.message) || e))}` };
  }
  if (!g || typeof g !== "object") {
    return { state: "UNKNOWN", why: "the shared trunk resolver returned no verdict object" };
  }
  const trunk = safeCell(String(g.trunk || "?"));
  const main = safeCell(String(g.main || "?"));
  if (g.ok !== true) {
    return { state: "UNKNOWN", trunk, main, why: `the resolver could not count '${main}..${trunk}'` };
  }
  if (g.sameRef === true) return { state: "NOT-APPLICABLE", trunk, main };
  // The DENOMINATOR and the two ref TIPS. A gap quoted without its population is a
  // bare quantity (`burndown-integrity.md` MUST-2), and a gap quoted without the
  // tips it was measured against cannot be told from a stale one
  // (`instrument-discipline.md` MUST-6). If any of the three is unreadable the whole
  // reading is UNKNOWN — emitting the gap alone would be exactly the bare quantity
  // MUST-2 blocks.
  const trunkTip = gitCaptureOrNull(repo, ["rev-parse", g.trunk]);
  const mainTip = gitCaptureOrNull(repo, ["rev-parse", g.main]);
  const population = gitCaptureOrNull(repo, ["rev-list", "--count", g.trunk]);
  const denom = population !== null && /^[0-9]+$/.test(population) ? Number(population) : null;
  if (trunkTip === null || mainTip === null || denom === null) {
    return {
      state: "UNKNOWN",
      trunk,
      main,
      why:
        `the gap counted, but its population and ref tips did not read back, so the figure would carry ` +
        `no denominator and no measured state`,
    };
  }
  return {
    state: "RESOLVED",
    ahead: g.ahead,
    denom,
    trunk,
    main,
    trunkTip: trunkTip.slice(0, 12),
    mainTip: mainTip.slice(0, 12),
  };
}

/** One line, carrying its bucket, its denominator, its measured state, and how to re-derive it. */
function renderPromotionGap(p) {
  if (!p || p.state === "UNKNOWN") {
    return (
      `UNKNOWN — ${(p && p.why) || "nothing measured it"}. This is an ABSENT reading, NOT a gap of zero: ` +
      `re-derive with 'git rev-list --count <remote>/main..<remote>/dev'.`
    );
  }
  if (p.state === "NOT-APPLICABLE") {
    return (
      `NOT APPLICABLE — '${p.trunk}' resolves to '${p.main}', so this repo has no separate integration ` +
      `trunk and there is no gap BY CONSTRUCTION. That is a different fact from a trunk that exists and ` +
      `happens to be level, and it is stated rather than rendered as a zero.`
    );
  }
  return (
    `${p.ahead} of ${p.denom} commit(s) reachable from ${p.trunk} are NOT yet on ${p.main} — bucket ` +
    `\`awaiting promotion\`, denominator \`commits reachable from ${p.trunk}\`. Measured LIVE at ` +
    `${p.trunk}=${p.trunkTip}, ${p.main}=${p.mainTip}. Re-derive: ` +
    `'git rev-list --count ${p.main}..${p.trunk}' (the gap, via ${TRUNK_REF_LIB_REL}) and ` +
    `'git rev-list --count ${p.trunk}' (the denominator).`
  );
}

function renderBlock({ pageRows, all }, sha, digest, promotion, acceptance) {
  const L = [];
  L.push(BEGIN);
  L.push("## Burndown");
  L.push("");
  L.push(BINDING_CLAUSE);
  L.push("");
  L.push("Status vocabulary (CLOSED — a value outside this set is a build refusal, exit 2):");
  L.push("");
  L.push("- `Signed off` — the owner has accepted it. The ONLY status that counts toward completion.");
  L.push("- `Built-not-walked` — built, not yet walked through with the owner. NOT complete.");
  L.push("- `In progress` — actively being worked.");
  L.push("- `Not started` — accepted into the register, no work begun.");
  L.push("- `Blocked on you` — waiting on the owner; cannot proceed here.");
  L.push("- `Open` — DERIVED, not assignable: `adjudicated` − `Signed off`.");
  L.push("");
  L.push(
    "`done`, `complete`, `closed`, `finished` and `remaining` are NOT count labels here. Each named at least two different buckets in prior reports, which is why the generator refuses them.",
  );
  L.push("");
  L.push("TWO POPULATIONS, THREE DENOMINATORS. Every figure is a fraction of ONE of these, and the column it sits in says which:");
  L.push("");
  L.push(
    "- `adjudicated` — items a person declared and adjudicated. **The COMPLETION denominator: a page is complete when `Signed off` equals `adjudicated`, and nothing else is completion.** The five status buckets and `Open` are fractions of THIS.",
  );
  L.push(
    "- `projected` — items PROJECTED from an external registry (an issue tracker, a deferral file). Their authoritative state lives there, and this board re-derives their MEMBERSHIP on every build. They are reported as membership and nothing else.",
  );
  L.push(
    "- `board` — every item of both classes. A CENSUS. It is NEVER a completion denominator and no status bucket is a fraction of it.",
  );
  L.push("");
  L.push(
    "A projected item is absent from every status bucket, and a `" +
      ABSENT_CELL +
      "` in this table means exactly that: the row carries no adjudicated items, so the question the column asks does not apply to it. It does NOT mean zero. `0 In progress` would be a claim that none of them are in progress; the truth is that a projection occupies no position on the owner-acceptance journey those buckets measure, so there is nothing to count.",
  );
  L.push("");
  L.push(
    "A projected item is `Open` by construction — it can never be `Signed off`, and `Open` is derived — which is why `Open: both populations` is the denominator the growth split partitions.",
  );
  L.push("");
  L.push(
    "Every column below is a BUCKET and every row states the DENOMINATOR that bucket binds. A figure quoted without both is not a figure from this block, and a figure quoted against the WRONG denominator does not validate.",
  );
  L.push("");
  L.push(
    "Each count is rendered `value⟨token⟩`. The token is derived from that count's own bucket, denominator, value and source digest, so a quoted figure is TAMPER-EVIDENT: change any of them and the token stops validating. Quote the token with the number — `burndown-build.mjs --quote <bucket>` prints a paste-ready sentence, and `--verify-quote <file|->` revalidates any text containing them.",
  );
  L.push("");
  L.push(`| page | ${COLUMNS.map(([, l]) => l).join(" | ")} |`);
  L.push(`| ${new Array(COLUMNS.length + 1).fill("---").join(" | ")} |`);
  // A cell whose column is absent on this row renders the dash and emits NO token —
  // the same decision `tokenIndex` makes, and it MUST be the same one: a rendered
  // token with no index entry would fail `--verify-quote` against the very block that
  // printed it.
  const cell = (row, k, label, denKey, absentWhenNoAdjudicated) =>
    absentWhenNoAdjudicated && row.adjudicated === 0
      ? ABSENT_CELL
      : renderCount(row[k], tokenFor(`${row.name}/${label}`, row[denKey], row[k], digest));
  for (const r of pageRows) {
    L.push(`| ${r.name} | ${COLUMNS.map(([k, l, d, a]) => cell(r, k, l, d, a)).join(" | ")} |`);
  }
  L.push(`| **ALL PAGES** | ${COLUMNS.map(([k, l, d, a]) => `**${cell(all, k, l, d, a)}**`).join(" | ")} |`);
  L.push("");
  // COMPLETION BINDS `adjudicated`. This is the sentence the whole two-denominator
  // change exists for: under one denominator it could never again read "complete",
  // because 221 projected items sat inside the total that `Signed off` was compared
  // against. The owner's question — "how much of what I ASKED FOR is done?" — is
  // answerable again.
  //
  // A page with NO adjudicated items is NEITHER complete nor incomplete, and it is
  // named rather than silently dropped: `0 of 0` would render as complete and report
  // an untouched projection as finished work, which is over-reporting, the costliest
  // direction (MUST-4's own rationale).
  const scored = pageRows.filter((r) => r.adjudicated > 0);
  const unscored = pageRows.filter((r) => r.adjudicated === 0);
  const incomplete = scored.filter((r) => r.signedOff !== r.adjudicated);
  const complete = scored.filter((r) => r.signedOff === r.adjudicated);
  const sentence =
    scored.length === 0
      ? `No page carries an adjudicated item, so completion is not defined for any of them.`
      : incomplete.length === 0
        ? `Every page carrying adjudicated work is complete: ${complete.map((r) => `${r.name} ${r.signedOff} of ${r.adjudicated}`).join(", ")}.`
        : complete.length === 0
          ? `No page is complete: ${incomplete.map((r) => `${r.name} is ${r.signedOff} of ${r.adjudicated}`).join(", ")}.`
          : `${complete.map((r) => `${r.name} is complete (${r.signedOff} of ${r.adjudicated})`).join(", ")}. ` +
            `${incomplete.map((r) => `${r.name} is not (${r.signedOff} of ${r.adjudicated})`).join(", ")}.`;
  const tail =
    unscored.length === 0
      ? ""
      : ` ${unscored.map((r) => r.name).join(", ")} carr${unscored.length === 1 ? "ies" : "y"} no adjudicated items` +
        ` (${unscored.reduce((a, r) => a + r.projected, 0)} projected), so completion is not defined there — that is an` +
        ` ABSENT result, not a complete one.`;
  L.push(`A page is complete only when \`Signed off\` equals \`adjudicated\`. ${sentence}${tail}`);
  L.push("");
  L.push(
    "PROMOTION GAP — the counter for the one thing this board would otherwise stop seeing. Lane work lands in the integration trunk continuously and for free; trunk → `main` is a separate, deliberate promotion. Work sitting in the trunk and not on `main` therefore no longer reads as unlanded to any surface that measures landedness, so `promotion_gap:` below counts it explicitly. It is a LIVE remote-ref reading and NOT a burndown count: it carries no token, it is no page's row, it is EXCLUDED from block identity exactly as `generated_from_sha:` is — a push to the trunk MUST NOT make `--check` red, and a value that depends on when this clone last fetched MUST NOT be part of what two operators compare — and it MUST NOT be quoted as a burndown figure. It states the two ref tips it was measured against so a stale reading is one command from being told apart from a current one.",
  );
  L.push("");
  L.push(`generated_from_sha: ${sha}`);
  L.push(`sources_digest: ${digest}`);
  L.push(`promotion_gap: ${renderPromotionGap(promotion)}`);
  L.push(`acceptance_channel: ${renderAcceptance(acceptance)}`);
  L.push("");
  L.push(END);
  return L.join("\n") + "\n";
}

// (c) A digest over the COMMITTED blob of every declared source, so a block whose
// sources moved is STALE and detectable without re-deriving a single count.
//
// AND A LIVE SOURCE CONTRIBUTES ITS RESOLVED MEMBERSHIP, not only its blob. A blob
// digest answers "did the declared FILES move?", which for a live source is the wrong
// question and always returns the same answer: a static file passes forever, so the
// gate could not tell "these sources have not moved" from "these sources CANNOT move".
// Folding the resolved membership in makes the digest move when the SUBJECT moves, so
// `--check`'s fast path reports the actionable cause, and a quoted figure stops
// validating once the registry it counted has drained or grown.
//
// NON-LIVE SOURCES ARE BYTE-IDENTICAL TO BEFORE — the extra `update` is inside the
// `if`, so every existing block's digest and every existing token is unchanged.
function sourcesDigest(sources) {
  const h = crypto.createHash("sha256");
  for (const s of [...sources].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    h.update(`${s.rel}\0${s.blob}\n`);
    // `digestInput` is what the live KIND declares its subject to be, not what this
    // function assumes it is. For `live-growth` it is the sorted membership — the exact
    // bytes this line hashed before `projected` existed, so no already-issued token
    // moves. For `projected` it additionally carries each member's DERIVED STATUS and
    // record ref, because a projection's status moves without any declared file moving:
    // a registry row changing state with the population unchanged would otherwise leave
    // the digest identical and `--check` would report a block CURRENT whose statuses
    // were the previous reading.
    if (s.live) h.update(`${s.rel}\0live\0${s.live.digestInput}\n`);
  }
  return h.digest("hex");
}

// ── build ───────────────────────────────────────────────────────────────────
function build(repo, manifestRel) {
  const manifest = loadManifest(repo, manifestRel);
  const sources = loadSources(repo, manifestRel, manifest);
  const items = resolveItems(sources, manifest.pages);
  // BEFORE the counts, deliberately. A broken chain must refuse the BLOCK, not
  // annotate it — a block that renders with a footnote saying some items are
  // untraceable is a block someone quotes, and the footnote is what gets dropped
  // in the quote. Refusing here means every mode (--write, --check, --json,
  // --quote) is gated on the same fact, so there is no path that emits a count
  // for an item whose context cannot be reached.
  const links = checkLinks(repo, manifestRel, manifest, items);
  const counts = tally(items, manifest.pages);
  // AFTER the tally, because the gate is a statement ABOUT the counts, and BEFORE the
  // render, on the same reasoning the link check states for itself: a board that refuses
  // must refuse the BLOCK, not annotate it. A footnote saying the acceptance channel has
  // never fired is a footnote that gets dropped in the quote.
  const acceptance = checkAcceptanceChannel(
    repo,
    manifest,
    manifestRel,
    counts.all,
    links === null ? null : links.lastAccepted,
    links === null ? null : links.kind,
  );
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const digest = sourcesDigest(sources);
  // Validate the token space BEFORE rendering. `renderBlock` hashes each cell
  // directly, so without this a colliding pair would be written into the block and
  // only surface later at --quote/--verify-quote time, on a block already
  // committed and already quoted. Every mode refuses on the same footing.
  tokenIndex(counts, digest);
  // LIVE, and deliberately so — unlike every count above, which is derived from
  // COMMITTED declared sources. The gap is a fact about two remote refs at this
  // moment, which is why it is rendered as provenance and excluded from block
  // identity below rather than folded into the digest.
  const promotion = measurePromotionGap(repo);
  return {
    manifest,
    counts,
    links,
    acceptance,
    // The measurements this build took, carried out for `--write`/`--reground` to bank.
    // A COPY, because `MEASURED` is module state the next `build()` in this process
    // resets — handing out the live array would let a second build empty the first
    // build's result from under its caller.
    measured: [...MEASURED],
    floors: FLOORS,
    block: renderBlock(counts, sha, digest, promotion, acceptance),
    sha,
    digest,
    sources,
    promotion,
  };
}

function spliceBlock(targetText, block) {
  const b = targetText.indexOf(BEGIN);
  const e = targetText.indexOf(END);
  if (b === -1 || e === -1) return targetText.replace(/\s*$/, "\n") + "\n" + block;
  if (e < b) refuse("target file has BURNDOWN:END before BURNDOWN:BEGIN");
  return targetText.slice(0, b) + block.trimEnd() + "\n" + targetText.slice(e + END.length + 1);
}

/**
 * The block's IDENTITY, for the staleness comparison only.
 *
 * `generated_from_sha` records WHICH COMMIT the block was generated at. It is
 * provenance, and it is deliberately NOT part of the block's identity, because it
 * moves with EVERY commit — including the commit that lands the block itself, and
 * every unrelated commit after it. Comparing it made `--check` report STALE
 * forever: regenerating produced a block carrying the new HEAD, committing that
 * block moved HEAD again, and the fixed point was unreachable by construction.
 *
 * A permanently-red check is worse than no check. It is the one an operator learns
 * to ignore, and then a GENUINELY stale block reads exactly like the everyday
 * state. What actually answers "is this block current?" is the pair that IS
 * compared: `sources_digest` (did the sources move?) and the counts themselves
 * (was it hand-edited?). Neither is weakened here.
 */
const IDENTITY_EXCLUDED_RX = /^generated_from_sha: .*$/gm;
/**
 * `promotion_gap` is excluded on the SAME reasoning, and for one additional one that
 * is stronger. It moves whenever anyone pushes to the trunk, so including it would
 * make `--check` red on every unrelated push — the permanently-red check the note
 * above explains is worse than no check. And it is read from REMOTE-TRACKING refs,
 * whose state is a function of when THIS clone last fetched: two operators
 * regenerating the same commit would produce different blocks and each would report
 * the other's as stale, which is a check whose verdict is operator-dependent.
 *
 * The trade-off is stated rather than hidden: a hand-edited `promotion_gap:` line is
 * NOT caught by `--check`, exactly as a hand-edited `generated_from_sha:` is not.
 * What bounds it is that the line carries the two ref tips it was measured against
 * and the command that re-derives it, so the reading is falsifiable in one command
 * by any reader who doubts it.
 */
const PROMOTION_GAP_EXCLUDED_RX = /^promotion_gap: .*$/gm;
/**
 * `acceptance_channel` is excluded for the STRONGEST version of the same reason.
 * `silentDays` is a function of TODAY, so including it in identity would make
 * `--check` red every single day with no source having moved — the permanently-red
 * check that gets ignored, and then a genuinely stale block reads like Tuesday.
 *
 * The same trade-off is stated rather than hidden: a hand-edited `acceptance_channel:`
 * line is not caught by `--check`. What bounds it is that the line carries the anchor
 * it was measured from and the two bounds it was measured against, so any reader who
 * doubts it re-derives it with `--check-links` in one command. And unlike the rendered
 * line, the REFUSAL is not cosmetic: it runs inside `build()`, so a board past its
 * bound produces no block to hand-edit at all.
 */
const ACCEPTANCE_EXCLUDED_RX = /^acceptance_channel: .*$/gm;
function blockIdentity(text) {
  return text
    .replace(IDENTITY_EXCLUDED_RX, "generated_from_sha: <provenance, not identity>")
    .replace(PROMOTION_GAP_EXCLUDED_RX, "promotion_gap: <live reading, not identity>")
    .replace(ACCEPTANCE_EXCLUDED_RX, "acceptance_channel: <live reading, not identity>")
    .trim();
}

function extractBlock(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b === -1 || e === -1 || e < b) return null;
  return text.slice(b, e + END.length) + "\n";
}

// ── the DECLARED half's identity ────────────────────────────────────────────
//
// WHY THIS EXISTS. `sources_digest` folds the live projections' resolved membership in
// alongside the declared files, on purpose (see `sourcesDigest`), so a single mismatch
// reports ONE fact — "something moved" — for two situations that call for opposite
// responses:
//
//   * a DECLARED file changed and nobody regenerated  → the block is STALE. Stop.
//   * the tracker gained or lost an issue             → the live reading is behind. The
//     LIVE half moves with no author action at all, so treating it as staleness made the
//     gate red on ANY issue opening or closing, for reasons that have nothing to do with
//     the content being promoted. MEASURED 2026-10-30: a block written at 141 open issues
//     was red at 159 (`19 created − 1 closed = +18`) without a single declared file moving.
//
// The separation is by ATTRIBUTION, not by exclusion: the live-derived cells are still
// rendered, still counted, still hashed into `sources_digest` and into every token, and
// the live query still runs and still clears its derived floor on every build. What this
// function does is answer the NARROWER question "would a regeneration change anything a
// DECLARED source owns?" — because that is the only difference a promotion gate may block
// on. It computes nothing new: it masks the live-derived positions on both sides of a
// comparison that `--promote` then makes.
//
// THE LIVE-DERIVED POSITIONS, derived from the ACCUMULATION in `tally`, never guessed:
//   - `projected`        counts projected items and nothing else.
//   - `board`            = adjudicated + projected.
//   - `openBoth`         = open + projected.
//   - `openArrivedSince` is accumulated for every item whose `origin` is not "register",
//                        and a projected item carries no `origin` at all — so every
//                        projected item lands here. `openFromRegister` is the sibling
//                        that keeps only origin==="register" items and is therefore
//                        DECLARED-derived; masking it would hide a real declared change.
const LIVE_IDENTITY_KEYS = Object.freeze(new Set(["board", "projected", "openBoth", "openArrivedSince"]));
const LIVE_IDENTITY_COLUMNS = Object.freeze(
  COLUMNS.map(([k], i) => (LIVE_IDENTITY_KEYS.has(k) ? i : -1)).filter((i) => i >= 0),
);
const LIVE_MASK = "\u0000live\u0000";
const SOURCES_DIGEST_RX = /^sources_digest: .*$/gm;
const PROJECTED_PROSE_RX = /\(\d+ projected\)/g;

/**
 * Replace the live-derived cells of ONE table row with a placeholder.
 * Rows are matched by SHAPE (a pipe-delimited line with `COLUMNS.length` body cells),
 * so the header, the separator and `**ALL PAGES**` are all treated identically and a
 * block generated by a different column set simply falls through unmasked rather than
 * being mis-read.
 */
const PROJECTED_COLUMN_INDEX = COLUMNS.findIndex(([k]) => k === "projected");

/** The body cells of a rendered table row, or null when the line is not one. */
function tableCells(line) {
  if (!line.startsWith("|")) return null;
  const trimmed = line.replace(/\s+$/, "");
  if (!trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|");
  if (cells.length - 1 !== COLUMNS.length) return null;
  return cells;
}

/** The row name as `parseBlockIndex` reads it — the bold on `**ALL PAGES**` is presentation. */
function rowNameOf(cell) {
  return String(cell).trim().replace(/^\*\*([\s\S]*)\*\*$/, "$1").trim();
}

/**
 * The rows that actually CARRY a live population, unioned over every text supplied.
 *
 * THE UNION IS LOAD-BEARING, and it is the difference between a tolerance and a hole. A
 * row with no live population has nothing that can move without an author action, so its
 * `board`/`openBoth`/`openArrivedSince` cells must stay COMPARED — masking them there
 * would excuse a hand-edit of a cell that is, on that row, purely declared-derived. The
 * union (not the fresh text alone) covers the drained case: a row whose tracker emptied
 * would otherwise stop being masked exactly as its figures changed, and a legitimate
 * drain would red the promotion.
 */
function livePopulatedRows(...texts) {
  const rows = new Set();
  for (const text of texts) {
    for (const line of String(text).split("\n")) {
      const cells = tableCells(line);
      if (!cells) continue;
      // TRIMMED **and UNBOLDED**, and neither is tidiness. A rendered cell is ` N⟨token⟩ `
      // with the padding the markdown table needs, and on the derived `**ALL PAGES**` row
      // every cell is wrapped in `**` — so an anchored match against the RAW cell fails
      // there and the row silently drops out of the set, which reads downstream as "this
      // row has no live population" and un-masks exactly the cells this function exists to
      // find. `parseBlockIndex` unwraps the same two things for the same reason.
      const cell = String(cells[1 + PROJECTED_COLUMN_INDEX]).trim().replace(/^\*\*([\s\S]*)\*\*$/, "$1").trim();
      const m = cell.match(/^(\d+)⟨[0-9a-f]{6}⟩$/);
      if (m && Number(m[1]) > 0) rows.add(rowNameOf(cells[0]));
    }
  }
  return rows;
}

/** Mask the live-derived cells of ONE row, and only on a row that carries a live population. */
function maskLiveCells(line, liveRows) {
  const cells = tableCells(line);
  if (!cells) return line;
  if (liveRows instanceof Set && !liveRows.has(rowNameOf(cells[0]))) return line;
  for (const i of LIVE_IDENTITY_COLUMNS) cells[1 + i] = ` ${LIVE_MASK} `;
  return "|" + cells.join("|") + "|";
}

/**
 * The block's DECLARED-derived identity: everything a declared source owns, and nothing
 * a live reading owns. Deliberately NOT the block's full identity — `blockIdentity` stays
 * exactly as it was — and it is the identity BOTH gates adjudicate on, because the
 * question "is the block current?" is only answerable for the half an AUTHOR owns.
 */
function declaredIdentity(text, { liveRows = null } = {}) {
  const out = blockIdentity(text);
  return out
    .split("\n")
    .map((l) => maskLiveCells(l, liveRows))
    .join("\n")
    .replace(SOURCES_DIGEST_RX, "sources_digest: <live-bound>")
    .replace(PROJECTED_PROSE_RX, "(<live> projected)")
    // TOKENS ARE DIGEST-DERIVED, so moving the live membership moves EVERY token in the
    // block — including the ones on declared-derived cells, whose VALUES did not change.
    // Left in, a single issue opening would red the declared half on 24 untouched cells,
    // which is the defect this whole change exists to remove, re-entering through the
    // fingerprints. The COUNTS stay compared in full; a token is checked against
    // `sources_digest` by `--verify-quote`, which is the surface that can re-hash it.
    .replace(TOKEN_RX, "$1⟨TOKEN⟩")
    .trim();
}

/**
 * The live-influenced CELLS that differ between two blocks, as `page/column: a -> b`.
 * The HITS, never a tally — the numbers a reader cannot recover from either block alone.
 * `shapeChanged` is reported separately because a table whose ROW COUNT moved is a
 * manifest change, not a live reading, and the two must not render identically.
 */
function liveDeltas(committedText, freshText) {
  const rowsOf = (t) =>
    t
      .split("\n")
      .filter((l) => l.startsWith("|"))
      .map((l) => l.replace(/\s+$/, ""));
  const a = rowsOf(committedText);
  const b = rowsOf(freshText);
  if (a.length !== b.length) return { shapeChanged: true, deltas: [] };
  const deltas = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const ca = a[i].slice(1, -1).split("|");
    const cb = b[i].slice(1, -1).split("|");
    if (ca.length !== cb.length || ca.length - 1 !== COLUMNS.length) return { shapeChanged: true, deltas };
    const name = ca[0].trim().replace(/^\*\*([\s\S]*)\*\*$/, "$1");
    for (const c of LIVE_IDENTITY_COLUMNS) {
      if (ca[1 + c] !== cb[1 + c]) deltas.push(`${name}/${COLUMNS[c][1]}: ${ca[1 + c].trim()} -> ${cb[1 + c].trim()}`);
    }
  }
  return { shapeChanged: false, deltas };
}

/**
 * WHICH DECLARED FILE MOVED — by NAME, which is the whole point.
 *
 * `sources_digest` is one hash over every source AND the live projections' resolved
 * membership, so on its own it cannot tell a declared file that changed from a tracker
 * whose issue count moved, and those two are opposite facts with opposite remedies. The
 * masking in `declaredIdentity` separates them but cannot name either.
 *
 * The NAMING half comes from what the block ALREADY records: `generated_from_sha` is the
 * commit the block was built at, so "did this file change since?" is one git read per
 * declared source — `git show <sha>:<path>` against the blob the build just counted.
 *
 * RETURNS NULL WHEN THE QUESTION CANNOT BE ANSWERED, and that is a real state rather than
 * a defensive flourish: a block whose `generated_from_sha` no longer resolves (a squashed,
 * rebased-away or garbage-collected history) supports no attribution at all. Absent is
 * reported as absent — never as "no source moved", which is a confident wrong answer of
 * exactly the kind this tool exists to refuse.
 */
function movedDeclaredSources(repo, sources, committedText) {
  const sha = (committedText.match(/^generated_from_sha: (\S+)$/m) || [])[1];
  if (!sha) return null;
  if (gitCaptureOrNull(repo, ["cat-file", "-e", `${sha}^{commit}`]) === null) return null;
  const moved = [];
  for (const s of sources.filter((x) => !x.live)) {
    const at = gitCaptureOrNull(repo, ["rev-parse", `${sha}:${s.rel}`]);
    if (at === null) moved.push(`${s.rel} (absent at ${sha.slice(0, 12)} — added since the block was generated)`);
    else if (at !== s.blob) moved.push(`${s.rel} (${at.slice(0, 12)} -> ${String(s.blob).slice(0, 12)})`);
  }
  return moved.sort();
}

/**
 * ONE ADJUDICATION, SHARED BY BOTH GATES — because a second copy of a verdict is how a
 * fix survives textually while the defect returns.
 *
 * THE QUESTION IT ANSWERS IS THE NARROW ONE: "would a regeneration change anything a
 * DECLARED source owns?" — because that is the only difference an author can act on. The
 * LIVE half moves with no author action at all (an issue opening, a deferral retiring),
 * so a gate that reds on it reds for a cause the gate's own subject does not contain.
 * MEASURED 2026-10-01: every declared source byte-identical to `origin/dev`, the tracker
 * at 161 against the block's recorded 159, and `--check` exited 1 STALE — a red naming
 * the tree and describing the tracker.
 *
 * WHAT IS *NOT* DONE, because it is the never-goes-stale shape: the live half is NOT
 * taken out of the block. Its cells are still rendered, still counted, still hashed into
 * `sources_digest` and into every token, and the live query still runs and still clears
 * its derived floor on every build. Dropping membership from block identity would make
 * the "Open issues" figure mean nothing — a gate that checks less while reading as fixed.
 * The separation is by ATTRIBUTION, never by exclusion.
 *
 * SO THE VERDICT IS `current` WITH THE LIVE DELTA CARRIED OUT SEPARATELY, never a red.
 * Three outcomes, and each is distinguishable from the others rather than collapsed:
 *   * `stale`   — a regeneration changes the DECLARED half. Opened by a declared source
 *                 that moved, or by a block someone edited by hand; `moved` says which,
 *                 and an EMPTY `moved` is the hand-edit case (no source moved at all).
 *   * `shape`   — the two blocks render different TABLE SHAPES (a row added or removed).
 *                 Column shape is a property of the manifest, not a live reading, so it
 *                 is a third state rather than either of the other two.
 *   * `current` — the declared half is what a regeneration produces; `deltas` carries
 *                 the live movement, as HITS, for the report the caller owes.
 */
function adjudicateDeclared(repo, sources, committedText, freshText) {
  // UNIONED over both sides, so a row whose tracker drained keeps its tolerance and a row
  // that never had one never gets it.
  const liveRows = livePopulatedRows(committedText, freshText);
  const before = declaredIdentity(committedText, { liveRows });
  const after = declaredIdentity(freshText, { liveRows });
  if (before !== after) {
    return {
      verdict: "stale",
      moved: movedDeclaredSources(repo, sources, committedText),
      before,
      after,
      deltas: liveDeltas(committedText, freshText).deltas,
    };
  }
  const live = liveDeltas(committedText, freshText);
  if (live.shapeChanged) return { verdict: "shape", deltas: [] };
  return {
    verdict: "current",
    deltas: live.deltas,
    // The WHOLE block, provenance and live cells included: `deltas` being empty means no
    // LIVE-INFLUENCED cell moved, and this says whether anything at all did (a provenance
    // line such as `promotion_gap:` is excluded from identity and moves on its own).
    wholeBlockChanged: blockIdentity(committedText) !== blockIdentity(freshText),
  };
}

/**
 * The STALE diagnosis, rendered ONCE for both gates. The facts are the adjudication's,
 * not the caller's, so the two modes cannot drift into telling an operator different
 * things about the same tree.
 *
 * `recorded` and `current` are the live-inclusive `sources_digest` values. The line
 * reports them and says plainly that the verdict was NOT read from them — that digest
 * folds the live membership in, so a mismatch alone distinguishes nothing, which is the
 * whole reason the adjudication above exists.
 */
function declaredStaleLines(adj, recorded, current) {
  const L = [];
  L.push(
    `  The block records sources_digest ${recorded || "(none)"}; the sources now digest to ${current}. ` +
      `That line folds the LIVE membership in as well, so it also moves for live-only movement, and the ` +
      `verdict above was not read from it.`,
  );
  if (adj.moved === null) {
    L.push(
      `  The source(s) cannot be NAMED: the block's recorded 'generated_from_sha' does not resolve in this ` +
        `checkout, so there is nothing to compare each declared source against. That is an ABSENT answer ` +
        `about attribution, not a clean one — the refusal stands on the comparison above, which did not ` +
        `name a file because none could be reached.`,
    );
  } else if (adj.moved.length) {
    L.push(
      `  DECLARED SOURCE(S) THAT MOVED SINCE THE BLOCK WAS GENERATED:\n${adj.moved.map((m) => `    - ${m}`).join("\n")}`,
    );
  } else {
    L.push(
      `  NO DECLARED SOURCE MOVED — every one is byte-identical to what the block was generated from. ` +
        `So the block ITSELF was edited: a rendered cell was changed by hand. The rendered table is not ` +
        `hand-maintainable; the generator owns every figure in it.`,
    );
  }
  // THE HITS. A verdict that says "something in the declared half moved" without saying
  // WHAT sends the reader back to diff two blocks by hand, and the reader who cannot find
  // it is the one who regenerates blindly — which is how a stale source gets papered over
  // instead of fixed.
  {
    const a = adj.before.split("\n");
    const b = adj.after.split("\n");
    const shown = [];
    for (let i = 0; i < Math.max(a.length, b.length) && shown.length < 8; i++) {
      if (a[i] !== b[i]) {
        shown.push(
          `    - committed: ${JSON.stringify((a[i] ?? "").slice(0, 160))}\n      fresh:     ${JSON.stringify((b[i] ?? "").slice(0, 160))}`,
        );
      }
    }
    if (shown.length) {
      L.push(`  DECLARED-DERIVED LINES THAT DIFFER${shown.length === 8 ? " (first 8)" : ""}:\n${shown.join("\n")}`);
    }
  }
  if (adj.deltas.length) L.push(`  (for context, the live reading also differs on ${adj.deltas.length} cell(s))`);
  return L;
}

/**
 * Format a quote from a supplied certified block snapshot, without rebuilding.
 * Every cell is revalidated by the verifier's parser. This proves fidelity to
 * that snapshot, not freshness against live sources; --quote still rebuilds.
 */
export function quoteFromBlock(text, wanted, sourceLabel = "supplied block") {
  const embedded = extractBlock(text);
  if (embedded === null) refuse(`the burndown target '${sourceLabel}' carries NO generated block`);
  const { idx } = parseBlockIndex(embedded, sourceLabel);
  return quoteFor(idx, wanted);
}

// ── quote + verify ──────────────────────────────────────────────────────────
//
// `--quote` exists to make the CORRECT path the LAZY path. Quoting a figure
// correctly must be cheaper than recomputing one, or the discipline loses to
// convenience every time. One command, paste-ready output, token included.
function quoteFor(idx, wanted) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const entries = [...idx.entries()];
  // EXACT before NORMALIZED. The normalizer folds spaces, underscores and hyphens
  // together so `all pages/open` finds `ALL PAGES/Open` — but that same folding
  // makes pages `A B` and `A-B` indistinguishable, and the previous code took
  // `hits[0]`, silently answering a DIFFERENT question than the one asked and
  // handing back a VALID token for it. A wrong count that validates is the worst
  // output this tool can produce, so an ambiguous request REFUSES.
  let hits = entries.filter(([, v]) => v.bucket === wanted);
  if (hits.length === 0) hits = entries.filter(([, v]) => norm(v.bucket) === norm(wanted));
  const distinct = [...new Set(hits.map(([, v]) => v.bucket))].sort();
  if (distinct.length > 1) {
    refuse(
      `'${wanted}' is AMBIGUOUS — it matches ${distinct.length} distinct buckets:\n  ` +
        distinct.join("\n  ") +
        `\nAsk for one of them EXACTLY. Guessing between them would emit a valid token for a count you did not ask for.`,
    );
  }
  if (hits.length === 0) {
    // ABSENT IS NOT MISSING, and the two get different messages. A status bucket on a
    // row with no adjudicated items exists and is correctly named — it simply carries
    // no count. Answering "no bucket matches" would send an operator hunting for a typo
    // in a name that is right, and worse, would read as though the board did not track
    // that page at all.
    const absent =
      (idx.absentBuckets && (idx.absentBuckets.get(wanted) || [...idx.absentBuckets.entries()].find(([b]) => norm(b) === norm(wanted))?.[1])) ||
      null;
    if (absent) {
      refuse(
        `'${wanted}' is ABSENT on that row, not zero. '${absent.row}' carries NO adjudicated items ` +
          `(${absent.projected} projected), and the status buckets measure a position on the ` +
          `OWNER-ACCEPTANCE journey that a projection of an external registry does not occupy. There is ` +
          `no count to quote, and quoting '0' would be a claim that none of them are in that state. ` +
          `Quote '${absent.row}/projected' or '${absent.row}/Open: both populations' instead.`,
      );
    }
    const available = [...new Set([...idx.values()].map((v) => v.bucket))].sort();
    refuse(
      `no bucket matches '${wanted}'. Available buckets:\n  ` +
        available.join("\n  ") +
        `\nIf the cut you need is not here, CHANGE THE GENERATOR — a one-off cut is the defect.`,
    );
  }
  const [tok, v] = hits[0];
  const base = `${v.row} — ${renderCount(v.value, tok)} of ${v.denominator} \`${v.label}\``;
  // MUST-3 BLOCKS a bare open count: every open figure splits `from the original
  // register` vs `arrived since`. So the quote that exists to make the correct
  // path the CHEAP one must carry the split for `Open` — otherwise the cheapest
  // path hands over a ready-to-paste sentence that breaches the rule the tool
  // enforces, and NEITHER hook arm can catch it: the token is VALID, so the
  // structural arm passes it, and the lexical arm only fires on UNtokened counts.
  // BOTH open figures carry the split, not just the adjudicated one. MUST-3 blocks a
  // bare OPEN count, and with two populations there are now two of them — `Open`
  // (adjudicated) and `Open: both populations`. Attaching the split to only the first
  // would leave the cheapest path emitting a bare open count for the larger figure,
  // which is the exact breach this attachment exists to prevent.
  if (v.label !== "Open" && v.label !== "Open: both populations") return base;
  const sameRow = (label) => [...idx.entries()].find(([, s]) => s.row === v.row && s.label === label);
  const from = sameRow("Open: from original register");
  const since = sameRow("Open: arrived since");
  if (!from || !since) return base;
  // Each split figure carries its OWN ROW, denominator and label — the full
  // canonical triple, repeated, not an addendum hanging off the first figure.
  //
  // BUG-A2: the addendum shape emitted a token the verifier could not bind. Once
  // the row became positional (see verifyQuotes) only the FIRST figure sat behind a
  // row, so swapping the leading row rejected two of the three tokens and the THIRD
  // — `arrived since`, which MUST-3 calls the highest-value column — still
  // validated, 78 chars past the row name. The generator's own canonical output was
  // therefore emitting a row-unbound count. Repeating the row costs a longer
  // sentence and buys the same guarantee on every figure.
  const one = (s, t) => `${v.row} — ${renderCount(s.value, t)} of ${s.denominator} \`${s.label}\``;
  return `${base}; ${one(from[1], from[0])}; ${one(since[1], since[0])}`;
}

/**
 * Revalidate every `N⟨token⟩` in arbitrary text against the CURRENT block.
 *
 * A quote is valid iff its token is one the current block produces AND the value
 * printed beside it is the value that produced that token. So altering the number
 * while keeping the token is caught, and so is a quote whose sources have moved
 * (every token changes with the source digest).
 *
 * Rendering is NOT part of the check: `5⟨abc123⟩`, `**5⟨abc123⟩**` and
 * `Open: 5⟨abc123⟩` all validate identically. The token binds the FACT, not the
 * typography — a verifier that rejected a bolded quote would train people to
 * strip tokens.
 */
function verifyQuotes(text, idx, digest) {
  const findings = [];

  // The generated block is `--check`'s subject, not this one's. Its cells are
  // bare by design (the column header IS the bucket and the row's `total` IS the
  // denominator), so scanning them here would demand context the table supplies
  // structurally. Excise the block regions and verify only QUOTES OF it.
  const scanned = text.replace(BLOCK_REGION_RX, (m) => " ".repeat(m.length));

  const rows = [...new Set([...idx.values()].map((v) => v.row))].sort(
    (a, b) => b.length - a.length, // longest-first, same reason as labels: `A B` before `A`
  );
  const labels = [...new Set([...idx.values()].map((v) => v.label))].sort(
    (a, b) => b.length - a.length, // longest-first: "Open: arrived since" before "Open"
  );
  // The ROW slot, anchored to end-of-`before` so it is POSITIONAL like the
  // label/denominator slot — see the BUG-A note at the match site below.
  const rowSlotRx = new RegExp(
    `(?:^|[\\s([])[*_\\x60]{0,2}(${rows.map(escapeRx).join("|")})[*_\\x60]{0,2}\\s*[—–:-]\\s*[*_]{0,2}$`,
    "iu",
  );

  let m;
  TOKEN_SCAN_RX.lastIndex = 0;
  while ((m = TOKEN_SCAN_RX.exec(scanned)) !== null) {
    const [raw, valueStr, tok] = m;

    // BUG-2: `\p{Nd}` catches FULLWIDTH/ARABIC-INDIC digits that ASCII `\d`
    // silently skipped, turning an evasion into a REFUSAL rather than a pass.
    if (!/^[0-9]+$/.test(valueStr)) {
      findings.push({
        raw,
        ok: false,
        why: `the value beside token '${tok}' uses non-ASCII digits (${[...valueStr].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ")}). A count is quoted in ASCII digits or not at all.`,
      });
      continue;
    }

    const known = idx.get(tok);
    if (!known) {
      findings.push({ raw, ok: false, why: `token '${tok}' is not produced by the current block` });
      continue;
    }

    // ── BUG-1: bind the WHOLE context, not just the integer ─────────────────
    // The token hashes bucket|denominator|value|digest, but the verifier used to
    // compare the value alone — so a token could be lifted onto a sentence that
    // named a different bucket and a different denominator and still validate.
    // Measured: a token certifying "5 of 7 Open" passed a sentence reading
    // "5 of 5 signed off", i.e. 100% complete against 29% reality. Parsing the
    // claimed context and RECOMPUTING the digest is what makes the token bind
    // what the rule says it binds.
    const after = scanned.slice(m.index + raw.length, m.index + raw.length + 160);
    const before = scanned.slice(Math.max(0, m.index - 120), m.index);

    // ONE positional match for both fields. The bucket is whatever sits in the
    // canonical slot immediately after `of <denominator>`; a label appearing
    // LATER in the sentence — e.g. the `Open: from original register` split that
    // MUST-3 requires the quote to carry — belongs to its OWN token, not this one.
    // Longest-match-anywhere made the generator's canonical output fail its own
    // verifier, which is how this was found.
    const labelAlt = labels.map(escapeRx).join("|");
    const slot = after.match(
      new RegExp(`^[^.\n]{0,40}?\\bof\\s+(\\p{Nd}+)\\s*\\x60?(${labelAlt})\\x60?`, "iu"),
    );
    const claimedDenom = slot ? slot[1] : null;
    const claimedLabel = slot ? labels.find((l) => l.toLowerCase() === slot[2].toLowerCase()) || slot[2] : null;

    // ── BUG-A: the ROW is the FOURTH hashed field and it gets the SAME positional
    // treatment as the other three. It used to be matched first-in-index-order
    // ANYWHERE in the preceding 120 chars, with a silent `|| known.row` fallback on
    // no-match — so three of the four hashed fields were bound and the fourth was
    // not, and a miss RE-INJECTED the certified row, making the recompute agree
    // with itself. Measured: five ordinary renderings of "Gamma is 1 of 3 Open",
    // carrying ALPHA's token while Gamma was 3 of 3, all validated — a heading with
    // trailing words, a newline, an intervening `.`, the row placed AFTER the count,
    // and >40 chars of prose each defeated the old window in a different way; a
    // sixth validated because `Alpha` matched FIRST in index order while the
    // sentence said `ALL PAGES`. Anchoring the row to the slot immediately BEFORE
    // the count removes every one of those degrees of freedom at once, and a MISSING
    // row is now a REFUSAL alongside a missing denominator/label rather than a
    // fallback. The cost is that `--quote`'s growth split must repeat the row on
    // each of its three tokens; a uniform guarantee is worth the longer sentence.
    const rowSlot = before.match(rowSlotRx);
    const claimedRow = rowSlot ? rows.find((r) => r.toLowerCase() === rowSlot[1].toLowerCase()) || rowSlot[1] : null;

    if (claimedDenom === null || claimedLabel === null || claimedRow === null) {
      const missing = [
        claimedRow === null ? "row" : null,
        claimedDenom === null ? "denominator" : null,
        claimedLabel === null ? "bucket" : null,
      ].filter(Boolean);
      findings.push({
        raw,
        ok: false,
        why:
          `no verifiable ${missing.join("/")} adjacent to token '${tok}'. ` +
          `MUST-2 requires all three, and without them the token binds only a bare integer — ` +
          `which is how a count certifying '${known.value} of ${known.denominator} ${known.label}' ` +
          `on ${known.row} could be pasted onto a sentence claiming something else. ` +
          `Quote the canonical form: ${quoteSentence(known, tok)}`,
      });
      continue;
    }

    // RECOMPUTE from what the TEXT claims. If the text is honest this reproduces
    // the token exactly; any drift in bucket, denominator or value breaks it.
    const recomputed = tokenFor(`${claimedRow}/${claimedLabel}`, Number(claimedDenom), Number(valueStr), digest);
    if (recomputed !== tok) {
      const parts = [];
      if (String(known.value) !== valueStr) parts.push(`value ${valueStr} (certified ${known.value})`);
      if (String(known.denominator) !== claimedDenom) {
        parts.push(`denominator ${claimedDenom} (certified ${known.denominator})`);
      }
      if (known.label.toLowerCase() !== claimedLabel.toLowerCase()) {
        parts.push(`bucket '${claimedLabel}' (certified '${known.label}')`);
      }
      if (known.row.toLowerCase() !== claimedRow.toLowerCase()) {
        parts.push(`row '${claimedRow}' (certified '${known.row}')`);
      }
      findings.push({
        raw,
        ok: false,
        why:
          `the surrounding text contradicts token '${tok}': ` +
          (parts.length ? parts.join("; ") : "recomputed digest does not match") +
          `. That token certifies ${known.value} of ${known.denominator} '${known.label}' on ${known.row}. ` +
          `The correct quote is: ${quoteSentence(known, tok)}`,
      });
      continue;
    }
    findings.push({ raw, ok: true, bucket: known.bucket });
  }
  return findings;
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function quoteSentence(known, tok) {
  return `${known.row} — ${renderCount(known.value, tok)} of ${known.denominator} \`${known.label}\``;
}

// ── selftest ────────────────────────────────────────────────────────────────
// The generator must be shown able to produce a DIFFERENT answer. A generator
// that cannot be shown to discriminate produces a number carrying no information
// (instrument-discipline.md MUST-1), however plausible that number looks.
//
// The two fixtures share a BYTE-IDENTICAL register and differ only in the sources
// layered on top, so every difference between the two blocks is attributable to
// those sources. The EXPECTED blocks were hand-computed and committed BEFORE this
// file existed — they are not derived from this generator, which is what keeps
// them from being a self-derived oracle (evidence-first-claims.md MUST-5).
// `promotion_gap` joins them for the same reason the other two are here: it is a LIVE
// remote-ref reading, so it CANNOT be hand-computed, and an EXPECTED file carrying it
// verbatim would be a self-derived oracle for a value that legitimately differs between
// two clones (evidence-first-claims.md MUST-5). Its own discrimination is proved where
// it is measured — three distinct states, none of which renders as another's value.
const PROVENANCE_RX = /^(generated_from_sha|sources_digest|promotion_gap|acceptance_channel): .*$/gm;

/**
 * Normalize the two SHA-derived surfaces before comparing against a
 * hand-computed EXPECTED block.
 *
 * WHY TOKENS ARE NORMALIZED OUT, stated because it looks like weakening the
 * oracle and is not: a token is a sha256 prefix, so it CANNOT be hand-computed,
 * and an EXPECTED file carrying generator-produced tokens would be a
 * self-derived oracle for exactly the values it is supposed to check
 * (evidence-first-claims.md MUST-5). The COUNTS stay hand-computed and fully
 * checked here; the TOKENS get their own behavioural discrimination proof
 * below (a changed value must stop validating, an equivalent rendering must
 * still validate), which is a stronger test than byte-equality against a
 * number nobody could derive by hand.
 */
function normalize(s) {
  return s.replace(PROVENANCE_RX, "$1: <PINNED>").replace(TOKEN_RX, "$1⟨TOKEN⟩");
}

function gitInitCommit(tmp) {
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "selftest@example.invalid"],
    ["config", "user.name", "burndown selftest"],
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    // The envelope applies HERE TOO, and not for symmetry's sake: this builds the
    // repository `--selftest` then measures, so an ambient GIT_DIR would send the
    // `init`/`add`/`commit` at a DIFFERENT repository and the selftest would
    // afterwards read a fixture nobody wrote — a green over an empty measurement.
    execFileSync(gitBinary(), [a[0], ...a.slice(1)], {
      cwd: tmp,
      stdio: "ignore",
      env: gitEnvLib().gitEnvForArgs([a[0]]),
    });
  }
  return tmp;
}

/**
 * Temp trees built by `--selftest`, removed when the process ends.
 *
 * WHY THIS EXISTS. Neither selftest repo builder ever removed its tree, so every
 * `--selftest` invocation leaked. MEASURED by the Tier-1 redteam across two
 * independent runs (50 and 125 trees created inside the run window, against a
 * firing control), with ~9,500 such directories standing — each a real git repo.
 * `burndown-integrity/run.mjs` drives `--selftest` twice per run, so the fixture
 * suite that just closed its OWN two leak sites was still feeding this one, and a
 * commit body claiming `DELTA=0` was true only for the prefix it measured. That
 * is an instrument scoped to one namespace being read as a statement about the
 * class — the failure this repo keeps paying for.
 */
const SELFTEST_DIRS = [];
let selftestCleanupArmed = false;
function armSelftestCleanup() {
  if (selftestCleanupArmed) return;
  selftestCleanupArmed = true;
  process.on("exit", () => {
    while (SELFTEST_DIRS.length) {
      try {
        fs.rmSync(SELFTEST_DIRS.pop(), { recursive: true, force: true });
      } catch {
        /* cleanup: a tree already gone is not this tool's finding */
      }
    }
  });
}

function initFixtureRepo(srcDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-selftest-"));
  armSelftestCleanup();
  SELFTEST_DIRS.push(tmp);
  fs.cpSync(srcDir, tmp, { recursive: true });
  fs.rmSync(path.join(tmp, "EXPECTED.md"), { force: true });
  fs.writeFileSync(path.join(tmp, "REGISTER.md"), "# Register\n");
  return gitInitCommit(tmp);
}

/**
 * A repository built from an inline file map, for the LIVE-source section below.
 *
 * INLINE rather than a committed fixture directory, and that is not a shortcut. A live
 * source declares `membership.as_of`, and a fixture carrying a LITERAL as_of is a time
 * bomb: it passes today and starts refusing on some future morning for a reason that has
 * nothing to do with the code under test. Computing the dates relative to TODAY is the
 * only way this section keeps measuring what it claims to measure.
 */
function initInlineRepo(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-selftest-live-"));
  armSelftestCleanup();
  SELFTEST_DIRS.push(tmp);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return gitInitCommit(tmp);
}

function selftest(fixtureRoot) {
  const results = {};
  let failures = 0;
  const say = (s) => console.log(s);

  for (const name of ["a", "b"]) {
    const srcDir = path.join(fixtureRoot, name);
    if (!fs.existsSync(srcDir)) refuse(`selftest fixture '${name}' not found at ${srcDir}`);
    const repo = initFixtureRepo(srcDir);
    const got = normalize(build(repo, "burndown-manifest.json").block);
    const want = normalize(fs.readFileSync(path.join(srcDir, "EXPECTED.md"), "utf8"));
    results[name] = { got, all: null };
    if (got.trim() !== want.trim()) {
      failures++;
      say(`FAIL selftest/${name}: generated block does not match the hand-computed EXPECTED.md`);
      const g = got.trim().split("\n");
      const w = want.trim().split("\n");
      for (let i = 0; i < Math.max(g.length, w.length); i++) {
        if (g[i] !== w[i]) say(`  line ${i + 1}\n    want: ${w[i]}\n    got:  ${g[i]}`);
      }
    } else {
      say(`PASS selftest/${name}: block matches hand-computed EXPECTED.md`);
    }
    // Strip the token decoration before reading the VALUES: the growth-split
    // assertion below is about the count, not its provenance marker.
    const m = got.match(/^\| \*\*ALL PAGES\*\* \|(.*)$/m);
    results[name].all = m
      ? m[1]
          .replace(/\*\*/g, "")
          .replace(/⟨[^⟩]*⟩/g, "")
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }

  // THE DISCRIMINATION ASSERTION, and the falsifying result stated out loud.
  const same = results.a.got.trim() === results.b.got.trim();
  say("");
  say("DISCRIMINATION — two inputs whose correct answers differ:");
  say(`  fixture a  ALL PAGES = [${results.a.all.join(", ")}]`);
  say(`  fixture b  ALL PAGES = [${results.b.all.join(", ")}]`);
  say(`  blocks differ: ${same ? "NO" : "YES"}`);
  if (same) {
    failures++;
    say(
      "FAIL discrimination: the generator returned the SAME block for two inputs whose correct answers differ. " +
        "It is not reading its sources, and every number it prints carries no information.",
    );
  }

  // The growth split specifically. A generator can move its totals while silently
  // dropping the split — the exact column a port is most likely to lose — so it
  // gets its own assertion rather than riding on whole-block inequality.
  const idx = COLUMNS.findIndex(([k]) => k === "openArrivedSince");
  const aG = results.a.all[idx];
  const bG = results.b.all[idx];
  say("");
  say("GROWTH SPLIT — the column a port is most likely to drop:");
  say(`  fixture a  'Open: arrived since' = ${aG}   (expected 0 — no growth source)`);
  say(`  fixture b  'Open: arrived since' = ${bG}   (expected 2 — two items arrived after the freeze)`);
  if (!(aG === "0" && bG === "2")) {
    failures++;
    say(`FAIL growth split: expected 0 then 2, got ${aG} then ${bG}. The split is not being computed.`);
  } else {
    say("  PASS: the split discriminates.");
  }

  // ── the TOKEN scheme's own discrimination proof ──────────────────────────
  // A verifier that accepts everything is the defect this mechanism exists to
  // name, so it is not enough that valid quotes pass: an altered one MUST fail,
  // and an equivalently-rendered correct one MUST still pass.
  say("");
  say("TOKEN DISCRIMINATION — a verifier that accepts everything is the defect:");
  {
    const repo = initFixtureRepo(path.join(fixtureRoot, "b"));
    const built = build(repo, "burndown-manifest.json");
    const idx = tokenIndex(built.counts, built.digest);
    const [tok, v] = [...idx.entries()].find(([, x]) => x.label === "Open" && x.row === "Beta");

    // The canonical quotable unit is the FULL sentence: value, token, denominator
    // and bucket together. A BARE `N⟨tok⟩` is now INVALID by design — that is what
    // closes BUG-1, where a token certifying "5 of 7 Open" validated a sentence
    // reading "5 of 5 signed off" because nothing but the integer was ever checked.
    const good = quoteSentence(v, tok);
    const wrongDenom = `${v.row} — ${renderCount(v.value, tok)} of ${v.denominator + 2} \`${v.label}\``;
    const wrongBucket = `${v.row} — ${renderCount(v.value, tok)} of ${v.denominator} \`Signed off\``;
    const cases = [
      ["valid canonical quote", good, true],
      ["same fact, BOLD rendering", `**${good}**`, true],
      ["same fact, inside a sentence", `Beta still has ${good} outstanding.`, true],
      ["VALUE ALTERED, token kept", good.replace(/(\d+)⟨/, (m, n) => `${Number(n) + 1}⟨`), false],
      ["DENOMINATOR altered, token kept", wrongDenom, false],
      ["BUCKET altered, token kept", wrongBucket, false],
      ["bare token, no bucket/denominator", renderCount(v.value, tok), false],
      ["token from nowhere", `${v.row} — ${renderCount(v.value, "ffffff")} of ${v.denominator} \`${v.label}\``, false],
    ];
    for (const [name, text, wantValid] of cases) {
      const f = verifyQuotes(text, idx, built.digest);
      const allOk = f.length > 0 && f.every((x) => x.ok);
      const got = allOk ? "VALIDATES" : "REJECTED";
      const pass = allOk === wantValid;
      if (!pass) failures++;
      say(`  ${pass ? "PASS" : "FAIL"} ${name.padEnd(28)} → ${got} (expected ${wantValid ? "VALIDATES" : "REJECTED"})`);
      if (!pass && f[0]) say(`       ${f[0].why || ""}`);
    }
    say(`  falsifying result: an altered value would print VALIDATES, and the`);
    say(`  scheme would carry no information. It printed REJECTED.`);
  }

  // ── LIVE SOURCES — the two behaviours a static snapshot could not have ────
  //
  // WHY THIS SECTION EXISTS ALONGSIDE THE a/b FIXTURES. Those two prove the generator
  // reads its FILES. A live source's whole point is that its membership is NOT in a
  // file, so a block built from one is only trustworthy if the generator is shown to
  // read the QUERY — and shown to REFUSE when the frozen half of the source has gone
  // stale. Both are stated with their falsifying results out loud.
  say("");
  say("LIVE MEMBERSHIP — the count follows the live registry, not the frozen snapshot:");
  {
    const ORIG = ["LIVE-01-BETA-ORIGINAL", "LIVE-02-BETA-ORIGINAL", "LIVE-03-BETA-DRAINS"];
    const daysAgo = (n) => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n))
        .toISOString()
        .slice(0, 10);
    };
    const reg = {
      _note: "selftest",
      _generated: "2026-08-01",
      _authority: "owner",
      items: [
        { id: "REG-01-ALPHA", page: "Alpha", status: "Signed off" },
        { id: "REG-02-BETA", page: "Beta", status: "In progress" },
      ],
    };
    const liveSrc = (asOf, maxAge) => ({
      _note: "selftest",
      _generated: "2026-08-20",
      _authority: "agent",
      membership: {
        command: [process.execPath, "query.mjs"],
        as_of: asOf,
        max_age_days: maxAge,
      },
      original_ids: ORIG,
      arrival_defaults: { page: "Beta", status: "Not started" },
      items: ORIG.map((id) => ({ id, page: "Beta", status: "Not started" })),
    });
    const manifest = {
      _schema: "burndown-manifest/v1",
      target: "REGISTER.md",
      pages: ["Alpha", "Beta"],
      floors: { path: "burndown/floors.json", max_drop_fraction: 0.25 },
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/live.json", kind: "live-growth", precedence: 0 },
      ],
    };
    // A floor DERIVED from an observation of 0 is 0, which is exactly what the
    // superseded `min_members: 0` meant here. These cases exist to vary MEMBERSHIP, so
    // the floor must not be the lever — it is neutralised deliberately, and the floor's
    // OWN behaviour is exercised by its own dedicated cases below and in
    // `.claude/audit-fixtures/burndown-integrity/run.mjs`.
    const floorsDoc = (members = 0) => ({
      _schema: FLOORS_SCHEMA,
      observations: { "burndown/live.json": { members, at: todayIso(), by: "reground", reason: "Selftest fixture baseline, seeded so the FLOOR is not the lever these cases vary." } },
    });
    const mk = (ids, asOf = daysAgo(1), maxAge = 30, floors = floorsDoc()) =>
      initInlineRepo({
        "REGISTER.md": "# Register\n",
        "query.mjs": `process.stdout.write(${JSON.stringify(ids.join("\n") + "\n")});\n`,
        "burndown/register.json": JSON.stringify(reg, null, 2) + "\n",
        "burndown/live.json": JSON.stringify(liveSrc(asOf, maxAge), null, 2) + "\n",
        "burndown/floors.json": JSON.stringify(floors, null, 2) + "\n",
        "burndown-manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      });
    const allOf = (repo) => {
      const b = build(repo, "burndown-manifest.json");
      // `board` is the census — the figure `total` used to be before it was split into
      // two denominators. A `live-growth` source produces ADJUDICATED items, so its
      // `adjudicated` figure equals its `board` figure and either would do here; `board`
      // is used because what this section measures is MEMBERSHIP.
      return { total: b.counts.all.board, arrived: b.counts.all.openArrivedSince, digest: b.digest };
    };

    // THE ONLY LEVER IS THE QUERY'S OUTPUT. Every committed byte is identical across
    // these three repositories: same register, same frozen original_ids, same
    // adjudication, same as_of. Only `query.mjs` differs.
    const frozen = allOf(mk(ORIG));
    const drained = allOf(mk(ORIG.slice(0, 2)));
    const arrived = allOf(mk([...ORIG, "LIVE-99-BETA-ARRIVED"]));
    say(`  live set = the frozen set  → ALL PAGES total ${frozen.total}, arrived since ${frozen.arrived}`);
    say(`  one original DRAINED       → ALL PAGES total ${drained.total}, arrived since ${drained.arrived}`);
    say(`  one member ARRIVED         → ALL PAGES total ${arrived.total}, arrived since ${arrived.arrived}`);
    const totals = [frozen.total, drained.total, arrived.total];
    const wanted = [5, 4, 6];
    if (totals.join(",") !== wanted.join(",")) {
      failures++;
      say(`  FAIL: totals were [${totals.join(", ")}], expected [${wanted.join(", ")}].`);
    } else if (frozen.arrived !== 3 || drained.arrived !== 2 || arrived.arrived !== 4) {
      failures++;
      say(
        `  FAIL growth split under liveness: arrived-since was ` +
          `${frozen.arrived}/${drained.arrived}/${arrived.arrived}, expected 3/2/4. ` +
          `The split is MUST-3's column and liveness must not flatten it.`,
      );
    } else {
      say("  PASS: drainage and arrival both move the count, and the split still partitions Open.");
    }
    say(
      `  falsifying result: if the query were ignored — which IS the defect, a static` +
        `\n  snapshot counted forever — all three would read ${frozen.total}. They read ` +
        `${totals.join(", ")}.`,
    );

    // The FRESHNESS GATE learns liveness too. Committed bytes identical, live set
    // different: the digest MUST move, or `--check`'s fast path cannot see the only
    // thing that changed.
    say("");
    say("FRESHNESS — sources_digest must move when the SUBJECT moves, not only the files:");
    if (frozen.digest === drained.digest) {
      failures++;
      say(
        `  FAIL: both repositories digest to ${frozen.digest}. A digest over committed blobs` +
          `\n  alone cannot tell 'these sources have not moved' from 'these sources CANNOT move'.`,
      );
    } else {
      say(`  PASS: ${frozen.digest.slice(0, 12)}… vs ${drained.digest.slice(0, 12)}… — the digest discriminates.`);
    }

    // ── staleness ─────────────────────────────────────────────────────────
    say("");
    say("STALENESS — a frozen adjudication must be distinguishable from a fresh one:");
    const tryBuild = (asOf, maxAge) => {
      try {
        build(mk(ORIG, asOf, maxAge), "burndown-manifest.json");
        return { built: true, why: "" };
      } catch (e) {
        if (!(e instanceof Unrunnable)) throw e;
        return { built: false, why: e.message.split("\n")[0] };
      }
    };
    const cases = [
      ["INSIDE the bound (2 days, bound 7)", daysAgo(2), 7, true],
      ["AT the bound (7 days, bound 7)", daysAgo(7), 7, true],
      ["PAST the bound (8 days, bound 7)", daysAgo(8), 7, false],
      ["far past the bound (60 days, bound 7)", daysAgo(60), 7, false],
      ["as_of in the FUTURE (gate-disabling edit)", daysAgo(-5), 7, false],
    ];
    for (const [name, asOf, maxAge, wantBuilt] of cases) {
      const r = tryBuild(asOf, maxAge);
      const ok = r.built === wantBuilt;
      if (!ok) failures++;
      say(
        `  ${ok ? "PASS" : "FAIL"} ${name.padEnd(42)} → ${r.built ? "BUILT" : "REFUSED"} ` +
          `(expected ${wantBuilt ? "BUILT" : "REFUSED"})`,
      );
      if (!ok && r.why) say(`       ${r.why}`);
    }
    say(
      `  falsifying result: with no bound enforced, the 60-day and future cases would both` +
        `\n  print BUILT and a four-month-old reading would ship as today's.`,
    );

    // FAIL CLOSED. A query that errors must refuse, NEVER quietly return the snapshot —
    // that fallback would reinstate the exact defect, at the worst possible moment.
    say("");
    say("FAIL-CLOSED — an unanswered query is UNRUNNABLE, never the snapshot:");
    const broken = initInlineRepo({
      "REGISTER.md": "# Register\n",
      "query.mjs": `process.stderr.write("registry unreachable\\n");\nprocess.exit(1);\n`,
      "burndown/register.json": JSON.stringify(reg, null, 2) + "\n",
      "burndown/live.json": JSON.stringify(liveSrc(daysAgo(1), 30), null, 2) + "\n",
      "burndown/floors.json": JSON.stringify(floorsDoc(), null, 2) + "\n",
      "burndown-manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    });
    let fellBack = null;
    try {
      fellBack = build(broken, "burndown-manifest.json").counts.all.total;
    } catch (e) {
      if (!(e instanceof Unrunnable)) throw e;
      fellBack = null;
    }
    if (fellBack === null) {
      say("  PASS: the build REFUSED. No block, no counts.");
    } else {
      failures++;
      say(
        `  FAIL: the build produced a total of ${fellBack} from a query that exited 1. ` +
          `That number is the frozen snapshot wearing a live label.`,
      );
    }
    say(`  falsifying result: a silent fallback would have printed ${frozen.total} here.`);
  }

  // ── PROJECTED SOURCES — the four properties, each with its falsifying result ──
  //
  // The `live-growth` block above proves membership is re-derived. It proves NOTHING
  // about status, because a `live-growth` source's status is frozen by construction.
  // Everything below is about the half that block cannot reach.
  say("");
  say("PROJECTED — status is DERIVED from the source record, never adjudicated locally:");
  {
    const reg = {
      _note: "selftest",
      _generated: "2026-08-01",
      _authority: "owner",
      items: [
        { id: "REG-01-ALPHA", page: "Alpha", status: "Signed off" },
        { id: "REG-02-BETA", page: "Beta", status: "In progress" },
      ],
    };
    const projDoc = (over = {}) => ({
      _note: "selftest",
      _generated: "2026-08-20",
      _authority: "agent",
      page: "Beta",
      membership: { command: [process.execPath, "query.mjs"] },
      status_derivation: { map: { open: "Not started", working: "In progress", waiting: "Blocked on you" } },
      record_ref: { kind: "external", pattern: "^rec://[a-z0-9-]+$" },
      items: [],
      ...over,
    });
    const manifest = {
      _schema: "burndown-manifest/v1",
      target: "REGISTER.md",
      pages: ["Alpha", "Beta"],
      floors: { path: "burndown/floors.json", max_drop_fraction: 0.25 },
      sources: [
        { path: "burndown/register.json", kind: "register", precedence: 0 },
        { path: "burndown/proj.json", kind: "projected", precedence: 0 },
      ],
    };
    // Neutralised for the same reason as the live-growth section above: these cases vary
    // the PROJECTION, so a floor that also moved would make a refusal ambiguous between
    // two causes — the exact failure-identity confusion `run.mjs`'s README records.
    const floorsDoc = (members = 0) => ({
      _schema: FLOORS_SCHEMA,
      observations: { "burndown/proj.json": { members, at: todayIso(), by: "reground", reason: "Selftest fixture baseline, seeded so the FLOOR is not the lever these cases vary." } },
    });
    // Each row is `id \t state \t record_ref`. THE ONLY LEVER IS THIS SCRIPT'S OUTPUT:
    // every committed byte is identical across the repositories below.
    const q = (rows) =>
      `process.stdout.write(${JSON.stringify(rows.map((r) => r.join("\t")).join("\n") + "\n")});\n`;
    const mk = (rows, doc, floors = floorsDoc(), mOver = {}) =>
      initInlineRepo({
        "REGISTER.md": "# Register\n",
        "query.mjs": q(rows),
        "burndown/register.json": JSON.stringify(reg, null, 2) + "\n",
        "burndown/proj.json": JSON.stringify(doc || projDoc(), null, 2) + "\n",
        "burndown/floors.json": JSON.stringify(floors, null, 2) + "\n",
        "burndown-manifest.json": JSON.stringify({ ...manifest, ...mOver }, null, 2) + "\n",
      });
    const tryBuild = (rows, doc) => {
      try {
        const b = build(mk(rows, doc), "burndown-manifest.json");
        return { built: true, all: b.counts.all, digest: b.digest, why: "" };
      } catch (e) {
        if (!(e instanceof Unrunnable)) throw e;
        return { built: false, all: null, digest: null, why: e.message.split("\n")[0] };
      }
    };
    const R = (id, state, ref) => [id, state, ref];
    const THREE_OPEN = [
      R("PROJ-01-ONE", "open", "rec://proj-01"),
      R("PROJ-02-TWO", "open", "rec://proj-02"),
      R("PROJ-03-THREE", "open", "rec://proj-03"),
    ];
    const THREE_MIXED = [
      R("PROJ-01-ONE", "working", "rec://proj-01"),
      R("PROJ-02-TWO", "waiting", "rec://proj-02"),
      R("PROJ-03-THREE", "open", "rec://proj-03"),
    ];
    const TWO_OPEN = THREE_OPEN.slice(0, 2);

    const allOpen = tryBuild(THREE_OPEN);
    const mixed = tryBuild(THREE_MIXED);
    const closed = tryBuild(TWO_OPEN);
    const fmt = (r) =>
      r.built
        ? `board ${r.all.board}, adjudicated ${r.all.adjudicated}, projected ${r.all.projected}, ` +
          `Signed off ${r.all.signedOff}, In progress ${r.all.inProgress}, Not started ${r.all.notStarted}, ` +
          `Blocked on you ${r.all.blockedOnYou}, arrived since ${r.all.openArrivedSince}`
        : `REFUSED (${r.why.slice(0, 70)})`;
    say(`  every record 'open'          → ${fmt(allOpen)}`);
    say(`  the SAME ids, states MOVED   → ${fmt(mixed)}`);
    say(`  one record CLOSED (drops out)→ ${fmt(closed)}`);
    if (!allOpen.built || !mixed.built || !closed.built) {
      failures++;
      say("  FAIL: a well-formed projected source refused.");
    } else {
      // (1) THE ADJUDICATION BUCKETS DO NOT MOVE when a projected item's registry
      // state changes. The two repos differ ONLY in the query's state field, and the
      // five buckets must be BYTE-FOR-BYTE identical across them — a projection
      // occupies no position on the owner-acceptance journey those buckets measure.
      const buckets = (a) => [a.signedOff, a.builtNotWalked, a.inProgress, a.notStarted, a.blockedOnYou].join(",");
      // (2) MEMBERSHIP is what a projected item reports, and it DOES move: a record
      // that closed leaves the population entirely.
      const membershipMoves =
        allOpen.all.board === 5 && closed.all.board === 4 && allOpen.all.projected === 3 && closed.all.projected === 2;
      // (3) The ADJUDICATED denominator is untouched by any of it — 2 register items,
      // always, which is what makes completion reachable again.
      const adjudicatedStable =
        allOpen.all.adjudicated === 2 && mixed.all.adjudicated === 2 && closed.all.adjudicated === 2;
      if (buckets(allOpen.all) !== buckets(mixed.all)) {
        failures++;
        say(
          `  FAIL: a projected item's registry state moved an ADJUDICATION bucket — ` +
            `[${buckets(allOpen.all)}] vs [${buckets(mixed.all)}]. Those buckets name positions on the ` +
            `OWNER-ACCEPTANCE journey and a projection occupies none of them.`,
        );
      } else if (!membershipMoves) {
        failures++;
        say(
          `  FAIL: membership did not follow the registry — board ${allOpen.all.board}/${closed.all.board}, ` +
            `projected ${allOpen.all.projected}/${closed.all.projected}, wanted 5/4 and 3/2.`,
        );
      } else if (!adjudicatedStable) {
        failures++;
        say(
          `  FAIL: the ADJUDICATED denominator moved with the projection — ` +
            `${allOpen.all.adjudicated}/${mixed.all.adjudicated}/${closed.all.adjudicated}, wanted 2/2/2.`,
        );
      } else {
        say(
          "  PASS: membership follows the registry, the adjudication buckets do not move with it, " +
            "and the adjudicated denominator is untouched.",
        );
      }
    }
    say(
      `  falsifying result: under ONE denominator these three rows moved the status buckets` +
        `\n  and the completion denominator together. Buckets now read [${[
          allOpen.all.signedOff,
          allOpen.all.builtNotWalked,
          allOpen.all.inProgress,
          allOpen.all.notStarted,
          allOpen.all.blockedOnYou,
        ].join(",")}] in all three; board reads ${allOpen.all.board}, ${mixed.all.board}, ${closed.all.board}.`,
    );

    // ── COMPLETION IS REACHABLE AGAIN — the defect the split exists to repair ──
    say("");
    say("PROJECTED — completion is REACHABLE while projected items exist:");
    {
      // Every ADJUDICATED item is Signed off; three projected items sit on the board.
      // Under one denominator this could never read complete, because `Signed off` was
      // compared against a total that contained items barred from ever being it.
      const doneReg = {
        _note: "selftest",
        _generated: "2026-08-01",
        _authority: "owner",
        items: [
          { id: "REG-01-ALPHA", page: "Alpha", status: "Signed off" },
          { id: "REG-02-ALPHA", page: "Alpha", status: "Signed off" },
        ],
      };
      const repo = initInlineRepo({
        "REGISTER.md": "# Register\n",
        "query.mjs": q(THREE_OPEN),
        "burndown/register.json": JSON.stringify(doneReg, null, 2) + "\n",
        "burndown/proj.json": JSON.stringify(projDoc(), null, 2) + "\n",
        "burndown/floors.json": JSON.stringify(floorsDoc(), null, 2) + "\n",
        "burndown-manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      });
      const b = build(repo, "burndown-manifest.json");
      const complete = /Every page carrying adjudicated work is complete: Alpha 2 of 2\./.test(b.block);
      const projectedPresent = b.counts.all.projected === 3 && b.counts.all.board === 5;
      // And the projected-only page must be named as NOT-DEFINED rather than complete.
      const betaAbsent = /Beta carries no adjudicated items \(3 projected\)/.test(b.block);
      say(`  adjudicated 2 of 2 Signed off, 3 projected on the board`);
      say(`  block says Alpha complete: ${complete ? "YES" : "NO"}`);
      say(`  projected items still counted: ${projectedPresent ? "YES" : "NO"}`);
      say(`  projected-only page reported as NOT-DEFINED, not complete: ${betaAbsent ? "YES" : "NO"}`);
      if (!complete || !projectedPresent || !betaAbsent) {
        failures++;
        say("  FAIL: completion did not survive the presence of projected items.");
      } else {
        say("  PASS.");
      }
      say(
        `  falsifying result: under ONE denominator this reads '2 of 5' and NEVER completes,` +
          `\n  no matter what the owner accepts. That is the defect this split repairs.`,
      );
    }

    // MUST-3's column, under the class that could most easily flatten it.
    say("");
    say("PROJECTED — the growth split survives (MUST-3's column):");
    // The split partitions `Open: both populations` — the one figure that spans the
    // two classes — because arrival is a fact about WHEN an item reached the board and
    // is orthogonal to which class it is in.
    const sp = allOpen.all;
    if (
      sp.openFromRegister + sp.openArrivedSince !== sp.openBoth ||
      sp.openArrivedSince !== 3 ||
      sp.openFromRegister !== 1
    ) {
      failures++;
      say(
        `  FAIL: split was ${sp.openFromRegister}+${sp.openArrivedSince} against 'Open: both populations' ` +
          `${sp.openBoth}; expected 1+3. A projected item is not the original ask and must land on ` +
          `'arrived since'.`,
      );
    } else {
      say(
        `  PASS: ${sp.openFromRegister} from the original register + ${sp.openArrivedSince} arrived since = ` +
          `'Open: both populations' ${sp.openBoth} (adjudicated Open ${sp.open} + projected ${sp.projected}).`,
      );
    }

    // THE GUARDRAIL. Structurally impossible, not merely unwritten.
    say("");
    say("PROJECTED — 'Signed off' is UNREACHABLE, and a member with no source record REFUSES:");
    const guard = [
      [
        "status_derivation.map declares 'Signed off' as a target",
        THREE_OPEN,
        projDoc({ status_derivation: { map: { open: "Signed off" } } }),
        false,
      ],
      [
        "a status-refresh aims at a projected id",
        THREE_OPEN,
        null,
        false,
        {
          sources: [...manifest.sources, { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 }],
          extra: {
            "burndown/refresh.json": JSON.stringify(
              {
                _note: "selftest",
                _generated: "2026-08-25",
                _authority: "owner",
                items: [{ id: "PROJ-01-ONE", status: "Signed off" }],
              },
              null,
              2,
            ) + "\n",
          },
        },
      ],
      [
        "a member's record_ref does not match the declared pattern",
        [R("PROJ-01-ONE", "open", "not-a-record"), ...THREE_OPEN.slice(1)],
        null,
        false,
      ],
      ["a member emits no record_ref field at all", [["PROJ-01-ONE", "open"]], null, false],
      ["a member reports a state the map does not translate", [R("PROJ-01-ONE", "merged", "rec://proj-01")], null, false],
      ["two members resolve to the SAME record_ref", [R("PROJ-01-ONE", "open", "rec://x"), R("PROJ-02-TWO", "open", "rec://x")], null, false],
      ["a projected source declares a local items[] status", THREE_OPEN, projDoc({ items: [{ id: "PROJ-01-ONE", page: "Beta", status: "Not started" }] }), false],
      ["the well-formed control (nothing wrong)", THREE_OPEN, null, true],
    ];
    for (const [name, rows, doc, wantBuilt, over] of guard) {
      let r;
      if (over) {
        const m = { ...manifest, sources: over.sources };
        const repo = initInlineRepo({
          "REGISTER.md": "# Register\n",
          "query.mjs": q(rows),
          "burndown/register.json": JSON.stringify(reg, null, 2) + "\n",
          "burndown/proj.json": JSON.stringify(projDoc(), null, 2) + "\n",
          "burndown/floors.json": JSON.stringify(floorsDoc(), null, 2) + "\n",
          "burndown-manifest.json": JSON.stringify(m, null, 2) + "\n",
          ...over.extra,
        });
        try {
          build(repo, "burndown-manifest.json");
          r = { built: true, why: "" };
        } catch (e) {
          if (!(e instanceof Unrunnable)) throw e;
          r = { built: false, why: e.message.split("\n")[0] };
        }
      } else {
        r = tryBuild(rows, doc);
      }
      const ok = r.built === wantBuilt;
      if (!ok) failures++;
      say(
        `  ${ok ? "PASS" : "FAIL"} ${name.padEnd(52)} → ${r.built ? "BUILT" : "REFUSED"} ` +
          `(expected ${wantBuilt ? "BUILT" : "REFUSED"})`,
      );
      if (!ok && r.why) say(`       ${r.why}`);
    }
    say(
      `  falsifying result: the CONTROL row is the discrimination proof — a gate that refused` +
        `\n  everything would print REFUSED there too, and would carry no information.`,
    );

    // ── THE DENOMINATOR IS BOUND INTO THE TOKEN — MEASURED, not assumed ───────
    //
    // With two populations in one table this stops being a nicety. If the token did
    // NOT bind the denominator, a figure computed against `projected` could validate a
    // sentence asserting it against `adjudicated` — which is the completion
    // denominator, so a projected count could certify a completion claim.
    say("");
    say("PROJECTED — the DENOMINATOR is bound into the token (a projected figure must not certify an adjudicated one):");
    {
      // (a) DIRECT. Everything held constant except the denominator. This isolates the
      // denominator as the ONLY variable; going through two builds could not, because
      // the source digest would differ too and the tokens would differ for that reason.
      const bucket = "ALL PAGES/Signed off";
      const d = "0".repeat(64);
      const tA = tokenFor(bucket, 26, 2, d);
      const tB = tokenFor(bucket, 247, 2, d);
      say(`  same bucket, same value 2, denominator 26 → ${tA}`);
      say(`  same bucket, same value 2, denominator 247 → ${tB}`);
      if (tA === tB) {
        failures++;
        say(
          "  FAIL: the denominator is NOT bound. A count against one population would validate a " +
            "sentence claiming it against the other, including the completion denominator.",
        );
      } else {
        say("  PASS: the denominator discriminates.");
      }
      // (b) END TO END, on a real two-population block: take a real cell and re-render
      // its sentence with a DIFFERENT denominator drawn from the same row. It must be
      // REJECTED, and the correct sentence must still VALIDATE — a verifier that
      // rejected both would prove nothing.
      const built = build(mk(THREE_OPEN), "burndown-manifest.json");
      const bIdx = tokenIndex(built.counts, built.digest);
      const entry = [...bIdx.entries()].find(([, v]) => v.row === "ALL PAGES" && v.label === "Open");
      if (!entry) {
        failures++;
        say("  FAIL: could not find the ALL PAGES/Open cell to test.");
      } else {
        const [tok, v] = entry;
        const other = [...bIdx.values()].find((x) => x.row === "ALL PAGES" && x.denominator !== v.denominator);
        const right = `${v.row} — ${renderCount(v.value, tok)} of ${v.denominator} \`${v.label}\``;
        const wrong = `${v.row} — ${renderCount(v.value, tok)} of ${other.denominator} \`${v.label}\``;
        const ok = (t) => {
          const f = verifyQuotes(t, bIdx, built.digest);
          return f.length > 0 && f.every((x) => x.ok);
        };
        const rightOk = ok(right);
        const wrongOk = ok(wrong);
        say(`  correct denominator (${v.denominator}) → ${rightOk ? "VALIDATES" : "REJECTED"} (expected VALIDATES)`);
        say(`  swapped denominator (${other.denominator}) → ${wrongOk ? "VALIDATES" : "REJECTED"} (expected REJECTED)`);
        if (!rightOk || wrongOk) {
          failures++;
          say("  FAIL: the end-to-end denominator binding does not discriminate.");
        } else {
          say("  PASS.");
        }
      }
    }

    // FRESHNESS — BIPOLAR, because both answers matter and they point opposite ways.
    say("");
    say("PROJECTED — sources_digest tracks MEMBERSHIP, and only membership:");
    {
      // MUST NOT move on a registry STATE change: under separate denominators a
      // projected item's state feeds no count, so a digest that moved here would
      // rewrite every token and report STALE against a block whose every figure is
      // identical — churn that teaches an operator to ignore `--check`.
      const stateOnly = allOpen.digest === mixed.digest;
      // MUST move on a MEMBERSHIP change, with every committed byte identical. This is
      // the half a blob-only digest cannot see, and it is the reason the field exists.
      const membershipMoved = allOpen.digest !== closed.digest;
      say(`  same ids, DIFFERENT registry states → digest ${stateOnly ? "UNCHANGED" : "MOVED"} (expected UNCHANGED)`);
      say(`  one member DRAINED                  → digest ${membershipMoved ? "MOVED" : "UNCHANGED"} (expected MOVED)`);
      if (!stateOnly || !membershipMoved) {
        failures++;
        say(
          `  FAIL: ${!stateOnly ? "a state-only change moved the digest, rewriting every token for a block whose counts are identical. " : ""}` +
            `${!membershipMoved ? "a drained member did NOT move the digest, so --check cannot see the one thing that changed." : ""}`,
        );
      } else {
        say(`  PASS: ${allOpen.digest.slice(0, 12)}… holds across states, and moves to ${closed.digest.slice(0, 12)}… on drainage.`);
      }
      say(
        `  falsifying result: a digest over committed BLOBS alone would print UNCHANGED on` +
          `\n  BOTH rows — a static file passes it forever — and the drainage would be invisible.`,
      );
    }
  }

  say("");
  say(failures === 0 ? "SELFTEST OK" : `SELFTEST FAILED — ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

// ── cli ─────────────────────────────────────────────────────────────────────
function usage() {
  return [
    "Usage: burndown-build.mjs [--manifest <path>] [--repo <dir>] [--write|--check|--json]",
    "       burndown-build.mjs --selftest [--fixtures <dir>]",
    "",
    "  --write     splice the generated block into the manifest's target file",
    "  --check     THE TREE CHECK: verify the target's embedded block is current against its DECLARED",
    "              sources (exit 1 if one moved, or if the block was hand-edited). Live-tracker movement",
    "              is REPORTED as deltas and is never a red here; the live reading is still re-derived, so",
    "              an unrunnable query is exit 2 — an ABSENT reading is not a clean one.",
    "  --promote   the PROMOTION-path gate: regenerate the block, then block only on what a",
    "              DECLARED source owns, naming the source that moved. Live-tracker movement is",
    "              absorbed and reported with its before -> after figures, and the target is",
    "              regenerated in place. Exit 1 = a declared source is stale, or the block was",
    "              hand-edited, or the table shape changed. Same verdict as --check, plus the write.",
    "  --json      emit the counts as JSON instead of the markdown block",
    "  --quote <bucket>      print a paste-ready, tokenised sentence for one count",
    "  --verify-quote <f|-> revalidate every N\u27E8token\u27E9 in a file or stdin",
    "  --check-links         report the id \u2192 tracker-row \u2192 context chain (exit 2 if broken)",
    "  --reground --subject <path> --reason <why>",
    "              bank THIS run's measured membership for ONE source as its floor.",
    "              For a drop LARGER than floors.max_drop_fraction, which refuses by design.",
    "              Writes a measurement the query RETURNED, never a number you typed.",
    "              The source path is REQUIRED: a re-ground is a claim about ONE",
    "              population, and a blanket one let a legitimate drain carry another",
    "              source's collapse into the record under a reason that was true of",
    "              neither.",
    "  --selftest  prove the generator can produce a DIFFERENT answer for different inputs",
    "",
    "Exit: 0 ok · 1 stale (--check) / selftest failed · 2 UNRUNNABLE (refused, no block)",
  ].join("\n");
}

function main(argv) {
  const args = { manifest: "burndown-manifest.json", repo: process.cwd(), mode: "print" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--fixtures") args.fixtures = argv[++i];
    else if (a === "--write") args.mode = "write";
    else if (a === "--check") args.mode = "check";
    else if (a === "--promote") args.mode = "promote";
    else if (a === "--json") args.mode = "json";
    else if (a === "--selftest") args.mode = "selftest";
    else if (a === "--check-links") args.mode = "check-links";
    else if (a === "--reground") args.mode = "reground";
    else if (a === "--subject") args.subject = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--quote") {
      args.mode = "quote";
      args.bucket = argv[++i];
    } else if (a === "--verify-quote") {
      args.mode = "verify-quote";
      args.input = argv[++i];
    }
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      return 0;
    } else refuse(`unknown argument '${a}'`);
  }

  // SET BEFORE `build()`, because the suspension has to be in force while the membership
  // query's floor check runs — that check is inside the resolver, not after it.
  //
  // A `--reason` is REQUIRED and is held to a length floor. "ok", "fixed" and "" are all
  // the same non-answer, and a re-grounding whose recorded justification is a shrug is
  // indistinguishable in the diff from one nobody thought about. The reason is written
  // into the committed file, so it is the sentence the reviewer reads.
  if (args.mode === "reground") {
    if (typeof args.reason !== "string" || args.reason.trim().length < REGROUND_REASON_MIN) {
      refuse(
        `--reground requires --reason "<why the smaller count is CORRECT>" of at least ` +
          `${REGROUND_REASON_MIN} characters. It suspends the one gate standing between a genuinely ` +
          `drained population and a query that half-failed at exit 0, so what it writes into the ` +
          `committed record is a human sentence a reviewer can disagree with — not a number.`,
      );
    }
    // A BARE `--reground` REFUSES. It must not fall back to suspend-ALL (the laundering
    // path this flag exists to close) and it must not silently suspend NOTHING either:
    // with no subject the per-subject guard would suspend no floor at all, so the
    // operator who followed the refusal message's own instruction would watch a command
    // appear to work and change nothing. A gate that silently no-ops when invoked is
    // worse than one that refuses, because it teaches the operator the gate is broken
    // and the next move is to route around it. So: refuse, and name the missing flag.
    if (typeof args.subject !== "string" || !args.subject || args.subject.startsWith("--")) {
      refuse(
        `--reground requires --subject <source-path>, naming the ONE source it re-grounds, as in\n` +
          `  --reground --subject burndown/projected-deferrals.json --reason "<why this count is correct>"\n` +
          `It used to take no subject and banked EVERY source in one act. MEASURED: that let one source's ` +
          `legitimate drain carry a SECOND source's 98% collapse into the committed record, stamped with a ` +
          `reason sentence that was TRUE of the first and silent about the second — provenance a reviewer ` +
          `cannot disagree with because it is accurate, and is simply not about that row. A re-ground is a ` +
          `claim about ONE population; two of them are two commands and two sentences.`,
      );
    }
    REGROUND_REASON = args.reason.trim();
    REGROUND_SUBJECT = args.subject;
  }

  if (args.mode === "selftest") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixtures =
      args.fixtures || path.resolve(here, "..", "audit-fixtures", "burndown-integrity", "selftest");
    return selftest(fixtures);
  }

  // ── `--verify-quote` DOES NOT BUILD, and the position of this branch is the
  // whole of the fix ────────────────────────────────────────────────────────────
  //
  // It sits ABOVE `build()` on purpose. Every mode below this line re-derives the
  // board, which on this repo costs ~6.1s and 229 subprocess spawns including a
  // `gh issue list` network round-trip — and the surface that calls this mode is a
  // Stop/PostToolUse hook holding a 3000ms `spawnSync` budget. So the verifier
  // timed out on every invocation and emitted its UNKNOWN third state whether the
  // quote was honest or forged, which is a non-discriminating instrument
  // (`instrument-discipline.md` MUST-1) rather than a slow one. Moving the branch
  // down even one function call restores that failure in full; see
  // `parseBlockIndex` for why a larger timeout is not the remedy.
  //
  // It reads the CERTIFIED BLOCK, which is the authority the rule already names,
  // and it re-hashes every cell it parses before trusting one. What it does NOT
  // answer is whether that block is current with its sources — `--check` owns
  // that, needs the rebuild, and runs in CI.
  if (args.mode === "verify-quote") {
    if (!args.input) refuse("--verify-quote needs a file path or '-' for stdin");
    const repoAbs = path.resolve(args.repo);
    let text;
    try {
      text = args.input === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args.input, "utf8");
    } catch (e) {
      refuse(`--verify-quote could not read '${args.input}': ${e.message}`);
    }
    // The manifest is loaded through the SAME validated loader every other mode
    // uses, not a second reader: `target` is the path this whole verdict is read
    // from, and `loadManifest`'s committed-and-unmodified assertion is what stops
    // a locally-edited manifest from redirecting verification at a block nobody
    // certified. It costs a handful of git spawns, not a rebuild.
    const manifest = loadManifest(repoAbs, args.manifest);
    const targetAbs = path.join(repoAbs, manifest.target);
    let targetText;
    try {
      targetText = fs.readFileSync(targetAbs, "utf8");
    } catch (e) {
      refuse(
        `--verify-quote could not read the burndown target '${manifest.target}' (${e.code || e.message}). ` +
          `The certified block is the only thing a quote can be valid AGAINST, so this is an UNKNOWN and ` +
          `not a pass.`,
      );
    }
    const embedded = extractBlock(targetText);
    if (embedded === null) {
      refuse(
        `the burndown target '${manifest.target}' carries NO generated block, so no quote in this text ` +
          `could be checked against anything. Generate it with '--write'.`,
      );
    }
    const { idx, digest: blockDigest } = parseBlockIndex(embedded, manifest.target);
    const findings = verifyQuotes(text, idx, blockDigest);
    const bad = findings.filter((f) => !f.ok);
    if (findings.length === 0) {
      console.log("burndown --verify-quote: no tokenised counts found; nothing to validate.");
      return 0;
    }
    // A FORGERY OUTRANKS A CAVEAT, and the order of these two branches is that
    // sentence. The rebuild path used to refuse OUTRIGHT on a modified source, so
    // an invalid quote written while the register happened to be mid-edit was
    // reported as "verification did not run" — the strongest available finding
    // suppressed by the weakest available doubt. Here the quote is checked against
    // the committed block first, because the block is what the quote CLAIMS to
    // quote and a dirty working tree does not change it.
    for (const f of bad) console.error(`INVALID QUOTE ${f.raw} — ${f.why}`);
    if (bad.length) {
      console.error(
        `\n${bad.length} of ${findings.length} tokenised count(s) FAILED validation. ` +
          `Re-quote from the block: burndown-build.mjs --quote <bucket>`,
      );
      return 1;
    }
    // BUG-5's CONTRACT, CARRIED ACROSS THE SEAM CHANGE RATHER THAN DROPPED WITH IT.
    // The rebuild path surfaced a modified declared source as an UNKNOWN, and that
    // mattered: a dirty source is the ordinary state while someone is moving the
    // register, which is exactly when the committed block is about to stop being
    // true. Verifying against the block alone would have answered "valid" there and
    // said nothing — a clean-looking result at the one moment counts are moving,
    // which is the shape BUG-5 was filed about. The check is a handful of git
    // spawns over the DECLARED source list (no rebuild, no membership query, no
    // network), so the caveat is affordable where the re-derivation was not.
    const unstable = [];
    for (const s of manifest.sources) {
      const rel = manifestDirOf(args.manifest) ? path.posix.join(manifestDirOf(args.manifest), s.path) : s.path;
      try {
        assertCommittedAndUnmodified(repoAbs, rel);
      } catch (e) {
        unstable.push(`${rel} — ${e instanceof Unrunnable ? e.message : e.message}`);
      }
    }
    if (unstable.length) {
      refuse(
        `every quote in this text is faithful to the block committed in ${manifest.target} ` +
          `(sources_digest ${blockDigest.slice(0, 12)}), but ${unstable.length} declared source(s) no ` +
          `longer match HEAD, so that block is not known to still be true:\n` +
          unstable.map((u) => `  - ${u}`).join("\n") +
          `\nThis is an UNKNOWN about CURRENCY, not a finding about the quotes — they were checked and ` +
          `they passed. Commit the sources and re-run 'burndown-build.mjs --write', then re-quote.`,
      );
    }
    // The digest is NAMED in the success line. A pass here means "faithful to the
    // block committed at this digest" and nothing more, and a reader who needs the
    // stronger claim needs `--check`; stating which authority was used is what
    // keeps the two from being read as one (`instrument-discipline.md` MUST-6).
    console.log(
      `burndown --verify-quote: ${findings.length} tokenised count(s) all valid against the block in ` +
        `${manifest.target} at sources_digest ${blockDigest.slice(0, 12)} ` +
        `(block-vs-sources currency is --check's question, not this one).`,
    );
    return 0;
  }

  const repo = path.resolve(args.repo);
  const { manifest, counts, links, block, digest, sources, acceptance, measured, floors } = build(
    repo,
    args.manifest,
  );

  // `--reground` BANKS AND STOPS. It deliberately writes no block: the operator is
  // asserting a measurement, and bundling a regeneration into that act would make one
  // command do two things, only one of which they asked for. The block is regenerated by
  // the `--write` that follows, against the floors this just committed.
  if (args.mode === "reground") {
    // ── AN EMPTY WRITE HAS TWO CAUSES AND THEY ARE OPPOSITE FACTS ─────────────
    //
    // `bankMeasurements` filters to the named subject, so `moved.length === 0` is
    // returned BOTH when that subject's measurement already matches the record and when
    // the subject was never measured at all — a typo in the path, or a source that is
    // neither live nor projected and therefore carries no floor. This line used to
    // report both as "every measurement already matches the committed record", which is
    // an empty outcome wearing the grammar of a completed one: the operator asked to
    // re-ground X, nothing about X happened, and the tool congratulated them
    // (`conservation-gate.md` MUST-4).
    //
    // It is also the SAME defect the `--reground` argument parser already refuses one
    // member of. A BARE `--reground` is refused there precisely because it "would
    // suspend no floor at all" and the operator "would watch a command appear to work
    // and change nothing" — and a MISNAMED subject did exactly that, one branch over.
    // The claim was ALSO over-broad in the other direction: it said EVERY measurement
    // matched, while a sibling subject drifting inside tolerance is filtered out before
    // this line can see it. The report is now scoped to the one subject the command
    // named, which is the only thing it ever had evidence about.
    const seen = measured.some((m) => m.subject === REGROUND_SUBJECT);
    if (!seen) {
      refuse(
        `--reground --subject ${REGROUND_SUBJECT} measured NOTHING. This build took no membership ` +
          `measurement for that subject, so there was nothing to re-ground and nothing was written — the ` +
          `command did not do what it was asked, which is a different fact from "already current".\n` +
          `  A subject is the repo-relative path of a LIVE or PROJECTED source, exactly as declared in ` +
          `the manifest. This build measured: ${
            measured.length === 0 ? "(none — this manifest declares no live or projected source)" : measured.map((m) => m.subject).join(", ")
          }`,
      );
    }
    const moved = bankMeasurements(floors, measured, REGROUND_REASON, REGROUND_SUBJECT);
    if (moved.length === 0) {
      console.log(
        `burndown --reground: ${REGROUND_SUBJECT} was measured and its count already matches the ` +
          `committed record; nothing written. That is a POSITIVE result about THAT SUBJECT, not a no-op ` +
          `failure — and it says nothing about any other subject, whose measurements this command ` +
          `deliberately did not touch.`,
      );
      return 0;
    }
    for (const m of moved) {
      console.log(`re-grounded ${m.subject}: ${m.from === null ? "(none)" : m.from} -> ${m.to}`);
    }
    console.log(
      `burndown --reground: wrote ${moved.length} measurement(s) into ${floors.rel}.\n` +
        `  COMMIT IT — the next build reads this file at HEAD and refuses while it is modified.\n` +
        `  Then regenerate the block: node .claude/bin/burndown-build.mjs --write`,
    );
    return 0;
  }
  // The target is the one manifest path that is WRITTEN, not merely read, so it is the
  // one where an unchecked `..` was a write-outside-the-repo primitive rather than a
  // read. It carried no shape check at all while `tracker.path` and `inventory.path`
  // each carried three (pre-existing, `230f8aab` 2026-08-18).
  //
  // TWO checks, and the second is not optional. `assertRepoRelative` is a STRING
  // check and closes the `..` half; it is blind to a SYMLINK, which is a property of
  // the filesystem and not of the path text. The `..` half was fixed at `230f8aab`
  // and the symlink half was left live — measured, both a symlinked LEAF and a
  // symlinked DIRECTORY COMPONENT spliced this block into a file in /tmp and exited 0
  // reporting success. `resolveContainedTarget` is what closes it, and its return
  // value — the CANONICAL path — is what every sink below uses.
  const targetRel = assertRepoRelative(args.manifest, "target", manifest.target);
  const targetAbs = resolveContainedTarget(repo, args.manifest, targetRel);
  // The DISPLAY path is DECLARED, never derived from `targetAbs`. `targetAbs` is now
  // the CANONICAL path, and `path.relative(repo, targetAbs)` compares a RAW root
  // against a resolved candidate — the very mismatch `resolveContainedTarget` exists
  // to avoid, reintroduced in the message. MEASURED when this line was that
  // expression: a perfectly ordinary write in a temporary checkout printed
  // `wrote block into ../../../../../../private/var/folders/…/REGISTER.md`, putting
  // the operator's absolute tree on stdout — the one disclosure every refusal in this
  // file is worded to prevent. Deriving it from the DECLARATION cannot drift.
  const targetShown = path.join(manifestDirOf(args.manifest), targetRel);

  // Reaching here at all means `build()` did NOT refuse, so the chain held. This
  // mode exists so the hook can ask the question without paying for a render,
  // and so an operator gets a POSITIVE statement of what was checked — "no
  // findings" and "nothing was checked" are opposite facts and a bare exit 0
  // renders them identically.
  if (args.mode === "check-links") {
    if (links === null) {
      console.log(
        `burndown --check-links: the manifest declares NO tracker, so NO link was checked. ` +
          `This is not a clean result — it is an absent one.`,
      );
      return 0;
    }
    // The SUBSTRATE is named, not left to be inferred from the path. "row in
    // .session-notes.shared.md" and "event in burndown/events.jsonl" are different
    // claims about where the verified evidence lives, and only one of them is
    // immutable — a reader who cannot tell which was checked cannot judge the
    // verdict's weight.
    console.log(
      `burndown --check-links: chain INTACT — ${links.checked} ADJUDICATED item(s) each resolve ` +
        `id → ${links.kind === "event-log" ? "event" : "row"} in ${links.trackerRel} → a tracked context ` +
        `artifact under ${links.roots.join(", ")}, and each of those artifacts carries its id verbatim.`,
    );
    // THE PROJECTED POPULATION, AND ITS BOUND. Two facts render identically without
    // this line — "there are no projected items" and "there are projected items and
    // nobody said what was checked for them" — and the second is the one that would let
    // a reader take LINK-1/2/3's verdict as covering the whole board. Zero is printed
    // for exactly that reason.
    {
      const projSrcs = sources.filter((s) => s.live && s.live.projected);
      const kinds = [...new Set(projSrcs.map((s) => s.live.refKind))];
      const external = projSrcs.filter((s) => s.live.refKind === "external");
      console.log(
        links.projected === 0
          ? `  LINK-S: 0 projected item(s) — this board declares no 'projected' source, so NOTHING was ` +
              `checked under that contract. An ABSENT result, not a clean one.`
          : `  LINK-S: ${links.projected} projected item(s) from ${projSrcs.length} source(s) ` +
              `(${links.projectedSources.join(", ")}) each resolved to a SOURCE RECORD — a reference ` +
              `matching that source's declared record_ref.pattern, unique across the population` +
              (kinds.includes("repo-path")
                ? `, and for its 'repo-path' source(s) DEREFERENCED to a tracked file — carrying the id verbatim, or, where the ref carries a '#' JSON pointer, with that pointer RESOLVED against the parsed document`
                : ``) +
              `. LINK-1/2/3 were NOT run for them: those legs are REPLACED for this class, not waived, ` +
              `and a member resolving to no source record refuses the build at load time.`,
      );
      if (external.length > 0) {
        console.log(
          `  LINK-S BOUND: ${external.length} source(s) declare record_ref.kind 'external' ` +
            `(${external.map((s) => s.rel).join(", ")}). Those references were checked for SHAPE and ` +
            `UNIQUENESS and were NOT FETCHED — the same commit must produce the same block on any day, ` +
            `so nothing here dereferences a remote record. This establishes ADDRESSABILITY, never ` +
            `existence, and that is stated rather than left for a green to imply.`,
        );
      }
    }
    // ABSENT is not CLEAN, and it is said rather than left to the exit code.
    // Coverage is the gate that grounds the DENOMINATOR; without it every count
    // in the block is internally rigorous over a population nobody checked.
    console.log(
      links.coverage === null
        ? `  COVERAGE: NOT CHECKED — the manifest declares no 'inventory'. This is an ABSENT result, ` +
            `not a clean one: nothing here has verified that the ${links.checked} item(s) above are the ` +
            `items this burndown was required to carry.`
        : `  COVERAGE: every inventory item resolves to a tracker row (or is named in a dated, ` +
            `owner-accepted migration_baseline).`,
    );
    if (links.kind === "event-log") {
      // THE READ GATE'S OWN NUMBERS, and printing them is not decoration.
      //
      // `verifySignedLog` returns `{verified, chained, closedChecked, authorityChecked, suite}` and this call site
      // IGNORED the whole object, printing only the LINK count. So on today's log a
      // green was consistent with "534 signatures verified, 0 chain records" AND
      // with "0 and 0" — opposite facts about what was checked, rendering
      // identically. `chained: 0` is a LIVE shape here rather than a hypothetical:
      // the chain is generation-scoped and generation 1 is EMPTY on this repo today,
      // so a reader is entitled to be told that rather than left to infer it.
      if (links.signatures) {
        // EACH GENERATION UNDER ITS OWN SUITE, spelled out. A single suite name here
        // is a claim about a population that does not exist on a multi-generation log,
        // and it is the one line an operator reads to answer "do the closed
        // generation's records still verify under the suite they were signed with?".
        const bySuite = links.signatures.verifiedBySuite || [];
        const suiteBreakdown = bySuite.length
          ? bySuite.map((s) => `${s.count} under '${s.suite}'`).join(", ")
          : `0 — NOTHING verified, which is an ABSENT result and not a clean one`;
        console.log(
          `  SIGNATURES: ${links.signatures.verified} record(s) verified, each under ITS OWN ` +
            `generation's suite (${suiteBreakdown}); the CURRENT generation accepts ` +
            `'${links.signatures.currentSuite}' for appends. ${links.signatures.chained} record(s) of the CURRENT ` +
            `generation carried the per-emitter chain` +
            (links.signatures.chained === 0
              ? ` — ZERO, which is an ABSENT result and not a clean one: the current generation holds ` +
                `no records yet, so the chain fires on the first append and certifies nothing today. ` +
                `The signature count is what carries this log.`
              : `.`) +
            ` ${links.signatures.closedChecked} record(s) of a CLOSED prior generation were checked to ` +
            `lie within the committed prefix.`,
        );
      }
      // SUPERSESSIONS, stated. The fold is last-wins per item and the diff of an
      // append does not show which line won, so a reviewer cannot see this from the
      // change alone. Zero is printed too — "none were superseded" and "nobody
      // looked" are opposite facts.
      console.log(
        links.superseded > 0
          ? `  SUPERSEDED: ${links.superseded} event(s) were overridden by a later event for the same ` +
              `item. That is the status-promotion channel working, not a fault — but the fold is last-wins ` +
              `and an append's diff does not show which line won, so the count is stated rather than left ` +
              `for a reviewer to derive.`
          : `  SUPERSEDED: 0 — every item's projection comes from a single event.`,
      );
      // The ONLY integrity floor on an append-only log, and it is OPTIONAL. Deleting
      // one manifest line retires it, and without this the output would be
      // byte-identical either way — absent reading exactly as clean, which is the
      // failure class this whole surface exists around.
      console.log(
        links.minRows === null
          ? `  ROW FLOOR: NOT DECLARED — the manifest carries no 'tracker.min_rows'. This is an ABSENT ` +
              `result, not a clean one: nothing here compares the log against its own history, so a ` +
              `truncation, a history rewrite, or a merge that dropped a side would pass unremarked.`
          : `  ROW FLOOR: ${links.rows.size} folded item(s) against a declared floor of ${links.minRows}.`,
      );
      // RETIREMENTS, stated separately and NEVER netted out of the floor above. A
      // retraction retires an item IN PLACE — its row stays, which is what keeps the
      // floor's monotonicity premise true — so the count above cannot show it, and a
      // reader who assumed the floor had excluded retired work would be reading a
      // number that means the opposite. Zero is printed too: "nothing is retired" and
      // "nobody looked" are opposite facts.
      if (links.retired !== null) {
        const shown = links.retired.slice(0, 10).map(safeCell).join(", ");
        console.log(
          links.retired.length > 0
            ? `  RETIRED: ${links.retired.length} of ${links.rows.size} folded item(s) carry a RETRACTION as ` +
                `their winning event and are retired IN PLACE — their rows remain in the population above, ` +
                `which is what keeps the ROW FLOOR a log-integrity floor rather than a work-state count: ` +
                `${shown}${links.retired.length > 10 ? `, … and ${links.retired.length - 10} more` : ""}.`
            : `  RETIRED: 0 — no item's winning event is a retraction.`,
        );
      }
      // PENDING COUNTERSIGNATURES. The HITS — record id, item and proposed status —
      // never a tally, because the tally sends the reader to grep the log for which
      // items it means (`instrument-discipline.md` MUST-3(b)) and the record id is
      // the exact argument the activation command takes. Zero is printed too: "no
      // owner decision is waiting" and "nobody looked" are opposite facts, and this
      // board exists because a decision that WAS made sat unrecorded for hours.
      if (links.pendingProposals !== null) {
        const pend = links.pendingProposals;
        const shown = pend
          .slice(0, 10)
          .map((x) => `${safeCell(x.item_id)} → '${safeCell(x.proposed_status)}' (proposal ${safeCell(x.record_id)}, line ${x.line})`)
          .join("; ");
        console.log(
          pend.length > 0
            ? `  PENDING COUNTERSIGNATURE: ${pend.length} proposal(s) are INERT and awaiting an OWNER ` +
                `activation. Each folds to NOTHING and changes no cell on this board until an owner ` +
                `appends an activation naming its record id: ${shown}` +
                `${pend.length > 10 ? `, … and ${pend.length - 10} more` : ""}. Activate with ` +
                `'node .claude/bin/burndown-countersign.mjs activate --proposal <record-id> --accepted-by "<your name>"'.`
            : `  PENDING COUNTERSIGNATURE: 0 — no proposal is awaiting an owner activation.`,
        );
      }
      // THE ACCEPTANCE CHANNEL'S OWN STATE, printed on every run including the quiet
      // ones. The PENDING line above says what is waiting; this one says whether the
      // channel that would clear it has been exercised at all, and how long the board
      // will tolerate the silence. Those are different facts: a board with zero pending
      // proposals and no acceptance in 59 days is one day from refusing, and the
      // PENDING line alone reports it as clean.
      console.log(
        acceptance.state === "absent"
          ? `  ACCEPTANCE CHANNEL: ABSENT — this manifest declares no 'acceptance' node, so NOTHING bounds ` +
              `how long the owner-acceptance channel may stay silent. ${acceptance.outstanding} of ` +
              `${acceptance.adjudicated} adjudicated item(s) are unaccepted and no gate is watching. That ` +
              `is an ABSENT result, not a clean one. Declare "acceptance": { "armed_on": "<today>", ` +
              `"warn_after_days": 30, "refuse_after_days": 60, "accepted_by": "<human>" }.`
          : acceptance.state === "not-applicable"
          ? `  ACCEPTANCE CHANNEL: not applicable — ${acceptance.adjudicated} adjudicated item(s), ` +
              `${acceptance.outstanding} outstanding, so the channel has nothing to accept. Its silence ` +
              `carries no information and is NOT scored as a stall.`
          : `  ACCEPTANCE CHANNEL: ${acceptance.state.toUpperCase()} — silent ${acceptance.silentDays} day(s) ` +
              `(warn past ${acceptance.warnAfter}, REFUSE past ${acceptance.refuseAfter}); ` +
              // THE TWO QUANTITIES ARE NAMED WITH THEIR SOURCES, because they are two
              // reads of two different files and reading them as one fact is what made
              // this line self-contradictory. `unaccepted` counts BOARD ITEMS whose
              // status came from a declared `sources[]` file; `Last owner acceptance`
              // dates a RECORD in the tracker log. Nothing propagates one into the other.
              `${acceptance.outstanding} of ${acceptance.adjudicated} adjudicated item(s) unaccepted ` +
              `(board items, from the declared sources[]). ` +
              (acceptance.lastAccepted === null
                ? `NO owner acceptance has EVER been recorded — the clock runs from acceptance.armed_on ` +
                  `${acceptance.armedOn}. 'Signed off' is the only route to completion on this board.`
                : `Last owner acceptance ${acceptance.lastAccepted} (a record in ${links.trackerRel}).`) +
              // ONLY when the monotonicity read could not be taken. A clean read prints
              // nothing extra — but silence must not be what an UNREADABLE history looks
              // like, because the anchor above is only as trustworthy as the arming date
              // it runs from, and that date is exactly what this read defends.
              (acceptance.armedOnCheck === "indeterminate"
                ? `\n    ARMED_ON MONOTONICITY: INDETERMINATE — git could not report which value ` +
                  `acceptance.armed_on replaced, so this run could NOT establish that the arming date ` +
                  `was not moved forward to reset the silence above. That is an unread check, not a ` +
                  `clean one.`
                : ``),
      );
      // THE JOIN, PRINTED. An owner acceptance that never reached the board is the one
      // state the two lines above CANNOT reveal between them: PENDING reads 0 (the
      // proposal WAS countersigned), the acceptance date moves to today, and the
      // `unaccepted` count does not move — three true sentences whose conjunction is a
      // defect nothing named. ABSENT is not CLEAN here either: `null` means this tracker
      // kind carries no activation records, so the join could not be taken at all.
      if (links.unlandedAcceptances === null) {
        console.log(
          `  ACCEPTANCE LANDING: NOT TAKEN — tracker kind '${links.kind}' carries no activation ` +
            `records, so no owner acceptance could be joined to a board item. That is an ABSENT ` +
            `result, not a clean one.`,
        );
      } else if (links.acceptancesJoined === 0) {
        // ABSENT, NOT CLEAN. Zero unlanded acceptances out of zero acceptances is a
        // vacuous green: the same output a fully-landed board produces, from a board
        // where the channel has never fired. It is printed as the ABSENT result it is.
        console.log(
          `  ACCEPTANCE LANDING: 0 owner acceptance(s) in ${links.trackerRel} name an item on this ` +
            `board, so this join examined NOTHING. That is an ABSENT result, not a clean one — it ` +
            `fires on the first owner activation naming a board item.`,
        );
      } else if (links.unlandedAcceptances.length === 0) {
        console.log(
          `  ACCEPTANCE LANDING: all ${links.acceptancesJoined} owner acceptance(s) in ` +
            `${links.trackerRel} are reflected by the board status of the item each names.`,
        );
      } else {
        const u = links.unlandedAcceptances;
        console.log(
          `  ACCEPTANCE LANDING: ${u.length} of ${links.acceptancesJoined} owner acceptance(s) DID ` +
            `NOT REACH THE BOARD. The ` +
            `countersignature is recorded in ${links.trackerRel} and the cell it names renders the ` +
            `status its declared source file still carries. The board takes status ONLY from ` +
            `sources[]; the tracker log is not a status source, so an activation alone cannot move a ` +
            `cell:\n` +
            u
              .slice(0, 10)
              .map((x) =>
                x.rendered === null
                  ? // OFF-BOARD. There is no cell and no source file to name, so no edit
                    // target is offered — a remedy pointing at a file that does not
                    // declare the item would send the operator somewhere nothing can be
                    // fixed. The honest finding is that the acceptance reached NOTHING.
                    `    ${safeCell(x.item_id)}: accepted '${safeCell(x.accepted)}' by ` +
                    `${safeCell(x.accepted_by)} on ${safeCell(x.on)}, but NO source[] file declares ` +
                    `this id, so this board carries no cell for it — the acceptance reached NOTHING. ` +
                    `Declare the item in a source, or withdraw the acceptance.`
                  : `    ${safeCell(x.item_id)}: accepted '${safeCell(x.accepted)}' by ` +
                    `${safeCell(x.accepted_by)} on ${safeCell(x.on)}, but the board renders ` +
                    `'${safeCell(x.rendered)}' from ${safeCell(x.source)}`,
              )
              .join("\n") +
            `${u.length > 10 ? `\n    … and ${u.length - 10} more` : ""}\n` +
            `    To land these, the OWNER sets the status in the source file named on each line — and ` +
            `where no file is named, declares the item in one first — then re-runs ` +
            `'node .claude/bin/burndown-build.mjs --write'. An agent MUST NOT make that edit ` +
            `(burndown-traceability.md MUST-4 — statuses are the owner's).`,
        );
      }
      // THE AUTHORITY BINDING, with its own denominator. `authorityChecked` is the
      // number of records CLAIMING a role-bound authority — the population this check
      // can speak about at all. Printing it is what stops a green from being read as
      // "every authority in this log was verified" when the honest reading is "no
      // record claimed one, so nothing was checked".
      if (links.signatures) {
        console.log(
          links.signatures.authorityChecked > 0
            ? `  AUTHORITY: ${links.signatures.authorityChecked} record(s) claiming a role-bound authority ` +
                `were verified against the COMMITTED operator roster (role + host_role), read at HEAD.`
            : `  AUTHORITY: 0 record(s) claim a role-bound authority, so this check examined NOTHING. That ` +
                `is an ABSENT result, not a clean one — it fires on the first record declaring one.`,
        );
      }
    }
    return 0;
  }

  if (args.mode === "quote") {
    if (!args.bucket) refuse("--quote needs a bucket, e.g. --quote 'ALL PAGES/Open'");
    console.log(quoteFor(tokenIndex(counts, digest), args.bucket));
    return 0;
  }
  // `--verify-quote` is handled ABOVE `build()` and never reaches here. The branch
  // that used to sit at this position is deliberately gone rather than left as an
  // unreachable fallback: a second copy of the verdict, reachable only if someone
  // moved the fast path back down, is exactly how a fix survives textually while
  // the defect returns.

  if (args.mode === "json") {
    // DRAINAGE IS REPORTED, never merely absorbed. An id that left a live registry
    // vanishes from every count by design — which means the ONLY surface that can say it
    // left is this one. A silently-smaller number and a registry nobody queried render
    // identically, and that is the pair this whole change exists to separate. `[]` is
    // emitted too: "nothing drained" and "nothing was live" are opposite facts.
    const live = sources
      .filter((s) => s.live)
      .map((s) =>
        // A PROJECTED source emits a DIFFERENT shape, and the branch is deliberate. It
        // has no frozen set, so `frozen_original`, `arrived_since_freeze` and
        // `drained_since_freeze` have no value — and emitting `0` for them would say
        // "nothing drained" where the honest statement is "there is no freeze to drain
        // from", two opposite facts rendering identically. What a projection CAN report
        // is the margin its floor leaves — `live_members` against `derived_floor`, WITH
        // the measurement that floor came from (`observed_members`, `observed_at`) and
        // the tolerance applied — which is the only thing standing between a genuinely
        // drained registry and a query that half-failed at exit 0, and the derived-status
        // breakdown. The provenance fields are not decoration: reporting a floor without
        // the measurement behind it restates a number nobody can check, which is the
        // shape that let a stale 70 sit unexamined until it refused a correct build.
        s.live.projected
          ? {
              source: s.rel,
              kind: s.kind,
              page: s.live.page,
              live_members: s.live.live.length,
              // The floor and the MEASUREMENT it was derived from, together. Reporting
              // the floor alone would restate a number without its provenance, which is
              // the shape that let a stale 70 sit unexamined for weeks.
              derived_floor: s.live.derivedFloor,
              observed_members: s.live.observedMembers,
              observed_at: s.live.observedAt,
              max_drop_fraction: s.live.maxDropFraction,
              record_ref_kind: s.live.refKind,
              record_ref_dereferenced: s.live.refKind === "repo-path",
              derived_status: s.live.stateCounts,
            }
          : {
              source: s.rel,
              kind: s.kind,
              as_of: s.live.asOf,
              live_members: s.live.live.length,
              frozen_original: s.live.originalCount,
              arrived_since_freeze: s.live.arrived,
              drained_since_freeze: s.live.drained,
            },
      );
    // THE ACCEPTANCE CHANNEL IS REPORTED ON EVERY RUN, not only when it fires. A gate
    // that speaks only on failure is one nobody knows is armed — which is exactly how
    // this repo's `migration_baseline` block sat DEAD for weeks while two separate
    // surfaces asserted the protection was live. `state: "quiet"` is a POSITIVE
    // statement that the channel was checked and had time left, and it is not the same
    // fact as `"not-applicable"`, which says there was nothing to accept.
    console.log(JSON.stringify({ pages: counts.pageRows, all: counts.all, live, acceptance }, null, 2));
    return 0;
  }
  if (args.mode === "print") {
    process.stdout.write(block);
    return 0;
  }
  if (args.mode === "write") {
    const cur = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, "utf8") : "";
    fs.writeFileSync(targetAbs, spliceBlock(cur, block));
    console.log(`burndown: wrote block into ${targetShown}`);
    // RE-GROUNDING RIDES ON THE WRITE, and only on the write. Every read-only mode stays
    // read-only — an operator running `--check` or `--json` must not find their tree
    // modified. `--write` is already the mode that mutates committed files, so the
    // measurement lands in the same act, and the same commit, as the block it belongs to.
    //
    // Reached only if the floor gate PASSED, because `build()` refused otherwise. So an
    // auto-banked value is by construction inside the declared tolerance; a drop larger
    // than that never reaches this line and needs `--reground --reason`.
    const moved = bankMeasurements(floors, measured, null, null);
    for (const m of moved) {
      console.log(
        `burndown: re-grounded floor for ${m.subject}: ${m.from === null ? "(none)" : m.from} -> ${m.to} ` +
          `(inside the declared tolerance of ${floors.frac}) — COMMIT ${floors.rel} with the block.`,
      );
    }
    return 0;
  }
  // ── --promote: the PROMOTION-path gate ───────────────────────────────────────
  //
  // ORDER IS THE POINT, and this is the item's chosen direction carried literally: the
  // step REGENERATES THE BLOCK ITSELF, and only then does it adjudicate. `block` above
  // IS that regeneration — it was built from the current declared sources AND the current
  // live reading, and building it ran the live membership query and cleared its derived
  // floor, so a collapsed or half-failed registry still refuses here (exit 2) exactly as
  // it does for `--write`.
  //
  // WHAT IT ADJUDICATES, and what it deliberately does NOT: it blocks on anything a
  // DECLARED source owns, and it does not block on the LIVE projection having moved. The
  // live half moves with no author action at all, so blocking on it made the promotion
  // gate red on ANY issue opening or closing — a red nobody could clear by doing the work
  // the gate exists to protect. The live half is NOT excluded from the block: its cells
  // are still rendered, still hashed into `sources_digest` and every token, and the
  // regeneration below writes the fresh reading into the target.
  //
  // `--check` asks the SAME question and reaches the SAME verdict through the SAME
  // adjudication below; the only difference between the two modes is that this one WRITES
  // the regenerated block back into the target. A preflight running `--check` and a CI step
  // running `--promote` must not disagree about a tree, and the shared `adjudicateDeclared`
  // is what makes that structural rather than a pair of call sites kept in step by hand.
  if (args.mode === "promote") {
    const targetText = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, "utf8") : "";
    const committed = extractBlock(targetText);
    if (committed === null) {
      fs.writeFileSync(targetAbs, spliceBlock(targetText, block));
      console.log(
        `burndown --promote: ${manifest.target} carried NO generated block, so there was nothing to ` +
          `compare and NOTHING WAS CHECKED. The block was generated and written; commit it.`,
      );
      return 0;
    }

    // ONE adjudication, shared with `--check` below: a second copy of this verdict is how
    // the two gates drift apart, and a preflight that reds where CI greens is the defect
    // this split exists to close. The TREE half is what it adjudicates; the LIVE half comes
    // back as `deltas` to be REPORTED.
    const adj = adjudicateDeclared(repo, sources, committed, block);
    const recorded = (committed.match(/^sources_digest: (\S+)$/m) || [])[1];

    if (adj.verdict === "stale") {
      console.error(
        `burndown --promote: STALE — a regeneration CHANGES what a DECLARED source owns. This is not ` +
          `the live projection moving; the declared half of the block is out of date.`,
      );
      console.error(declaredStaleLines(adj, recorded, digest).join("\n"));
      console.error(
        `\nRegenerate with 'node .claude/bin/burndown-build.mjs --write' and COMMIT the result, then ` +
          `re-run the promotion. Do NOT hand-edit the rendered table.`,
      );
      return 1;
    }
    if (adj.verdict === "shape") {
      console.error(
        `burndown --promote: the committed block and a fresh generation render DIFFERENT TABLE SHAPES ` +
          `(a row was added or removed). Column shapes are a property of the manifest, so this is not ` +
          `live movement — regenerate with '--write' and review the diff.`,
      );
      return 1;
    }

    // The declared half is current, so every difference the fresh block carries is the
    // LIVE reading moving. Report the hits — page, column, before -> after — rather than a
    // tally: the delta is the one thing a reader cannot recover from the block alone.
    const deltas = adj.deltas;
    const changed = adj.wholeBlockChanged;
    fs.writeFileSync(targetAbs, spliceBlock(targetText, block));
    if (!changed) {
      console.log(
        `burndown --promote: ${manifest.target} is current — a fresh generation reproduces the committed ` +
          `block byte for byte (declared half and live reading both unchanged).`,
      );
      return 0;
    }
    console.log(
      `burndown --promote: the DECLARED half is current. The LIVE projection moved since this block was ` +
        `written, and that is not staleness — it is the registry being re-read. The target has been ` +
        `REGENERATED in place; commit the result if this checkout is the one being promoted.\n` +
        (deltas.length
          ? deltas.map((d) => `  live delta — ${d}`).join("\n")
          : `  (no live-influenced cell changed; the provenance lines differ)`),
    );
    return 0;
  }

  // ── --check: THE TREE CHECK ──────────────────────────────────────────────────
  //
  // WHAT IT ADJUDICATES, and what it deliberately does not. The verdict is over the
  // DECLARED half only — a declared source that moved without a regeneration, or a block
  // someone edited by hand — because that is the half an AUTHOR owns. The LIVE half is
  // REPORTED, never a red: its membership moves with fleet activity and nothing in the
  // tree changing, so blocking on it made this gate red for a cause its own subject does
  // not contain. MEASURED 2026-10-01: with all four declared sources byte-identical to
  // `origin/dev` and the tracker at 161 against the block's recorded 159, `--check` exited
  // 1 with a message naming the tree and describing the tracker.
  //
  // A PRIOR COMMENT HERE WAS FALSE, and the false part is named rather than deleted: it
  // claimed the digest comparison above was "the declared sources now digest to <b>".
  // `sources_digest` folds each live projection's RESOLVED MEMBERSHIP in as well, on
  // purpose, so the mismatch it reported was equally consistent with a tracker that had
  // moved and with a declared file that had — two facts with opposite remedies, reported
  // as one. It also claimed no count was re-derived; true, and beside the point.
  //
  // THE DISCRIMINATION IS NOT WEAKENED, and that is the acceptance: a declared source that
  // moved still exits 1 NAMING the file (and the hand-edit case still exits 1, naming the
  // block itself), both through the SAME adjudication `--promote` uses. What changed
  // verdict is live-only movement. Membership stays IN block identity — rendered, counted,
  // hashed into `sources_digest` and every token — so the projected figure still means
  // something; the live reading is simply not what this gate refuses on.
  //
  // THE LIVE READING STILL COSTS A QUERY. This mode builds, and building re-derives the
  // membership so the report below is a real reading rather than a stale one. That is why
  // an unrunnable query is exit 2 here — an ABSENT live reading is not a clean one.
  if (!fs.existsSync(targetAbs)) {
    refuse(`target '${manifest.target}' does not exist; nothing to check`);
  }
  const embedded = extractBlock(fs.readFileSync(targetAbs, "utf8"));
  if (embedded === null) {
    console.error(`burndown --check: target '${manifest.target}' carries NO generated block.`);
    return 1;
  }
  {
    const adj = adjudicateDeclared(repo, sources, embedded, block);
    const recorded = (embedded.match(/^sources_digest: (\S+)$/m) || [])[1];
    if (adj.verdict === "stale") {
      console.error(
        `burndown --check: STALE — a regeneration CHANGES what a DECLARED source owns, so the block in ` +
          `'${manifest.target}' is out of date. This is the TREE check: it refuses on the declared half ` +
          `only, and live-tracker movement is NOT a red here.`,
      );
      console.error(declaredStaleLines(adj, recorded, digest).join("\n"));
      console.error(
        `\nRegenerate with 'node .claude/bin/burndown-build.mjs --write' and COMMIT the result. ` +
          `Do NOT hand-edit the rendered table.`,
      );
      return 1;
    }
    if (adj.verdict === "shape") {
      console.error(
        `burndown --check: the committed block and a fresh generation render DIFFERENT TABLE SHAPES ` +
          `(a row was added or removed). Column shapes are a property of the manifest, not a live ` +
          `reading — regenerate with '--write' and review the diff.`,
      );
      return 1;
    }
    // The declared half is current. Everything below is the LIVE PROJECTION, reported
    // separately and never as a red.
    if (!adj.wholeBlockChanged) {
      console.log(`burndown --check: block in ${manifest.target} is current.`);
      return 0;
    }
    console.log(
      `burndown --check: the DECLARED half is current — every declared source is byte-identical to what ` +
        `this block was generated from. The LIVE projection moved since it was written, and that is the ` +
        `registry being re-read, NOT staleness:\n` +
        (adj.deltas.length
          ? adj.deltas.map((d) => `  live delta — ${d}`).join("\n")
          : `  (no live-influenced cell changed; a provenance line such as 'promotion_gap:' did)`),
    );
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Unrunnable) {
      // Deliberately loud, and deliberately NOT shaped like a summary. A refused
      // build read as a clean one is the failure this banner exists to prevent.
      process.stderr.write(`UNRUNNABLE — refusing because ${e.message}\n`);
      process.stderr.write("This is exit 2. It is NOT a pass. No burndown block was produced.\n");
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}
