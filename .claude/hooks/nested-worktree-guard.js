#!/usr/bin/env node
/**
 * Hook: nested-worktree-guard
 *
 * @hook-event: PreToolUse:Task|Agent|EnterWorktree (guard) — the subject is ONE
 *   action, the delegation/re-root call that CREATES the worktree, and it exists
 *   only in this call's structured input; these are the only tools that can
 *   perform it, so the matcher names exactly them. A `*` matcher is BLOCKED for a
 *   `guard` class by hook-event-selection.md MUST-3, and a later event is too
 *   late — by PostToolUse the nested checkout already exists and the agent is
 *   already rooted in it.
 *
 * Severity: block — rationale in § SEVERITY below.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS BLOCKS
 * ─────────────────────────────────────────────────────────────────────────
 * A delegation tool call carrying `isolation: "worktree"`, and an
 * `EnterWorktree` whose RESOLVED target is a nested placement. When the harness
 * honors the isolation flag it creates the agent's worktree at
 *
 *     <repo>/.claude/worktrees/agent-<id>/
 *
 * — NESTED inside the repo, directly under the repo's own `.claude/`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MECHANISM, AND WHY PLACEMENT DECIDES IT
 * ─────────────────────────────────────────────────────────────────────────
 * The CC runtime keys path-scoped (`priority: >0`) rules on the resolved
 * directory chain above the TOUCHED FILE, walking up past the agent's own root
 * into any ancestor `.claude/`. A NESTED worktree has TWO matching `.claude/`
 * roots above every file it touches; a SIBLING outside the repo has one. So a
 * session or agent rooted in a nested worktree loads the matching path-scoped
 * corpus TWICE — once from its own `.claude/rules/` and once from the ancestor
 * repo's. `CLAUDE.md` and baseline (`priority: 0`) rules do NOT ancestor-load.
 *
 * MEASURED AT LOOM (2026-07-26, CC 2.1.220, untracked-sentinel probe with a
 * negative control; 2/2 runs). Untracked sentinel rules were planted at the
 * OUTER root only, so no worktree checkout can contain them. A nested-rooted
 * session loaded the same path-scoped rule TWICE under two distinct paths AND
 * received the ancestor-ONLY rule in full; a SIBLING-rooted session loaded each
 * exactly once with zero ancestor content. The negative control (a rule scoped
 * to a glob matching nothing) did NOT appear, so the injection is genuinely
 * path-scope-triggered rather than indiscriminate. Protocol + full matrix:
 * `skills/30-claude-code-patterns/worktree-orchestration.md` § Ancestor-Load
 * Measurement; the committed instrument is `bin/probe-ancestor-load.mjs`.
 *
 * COST, FROM LOOM'S OWN CORPUS — never a downstream repo's figure, which that
 * same section warns is "a different harness". Loom carries 74 path-scoped rules
 * totalling 1,185,700 B (exact, frontmatter scan). A single `.claude/rules/**`
 * touch matches ~13 of them ≈ 291,914 B (~73k tokens), which a nested root pays
 * TWICE. The per-touch digits are INDICATIVE — they come from a reimplemented
 * glob matcher, and an independent reimplementation put the same touch at 15
 * rules / ~334 KB. The DUPLICATION is measured; only its per-touch size is an
 * approximation.
 *
 * METHOD LESSON (why this survived prior audits, twice, in opposite directions):
 *   1. Duplicate loading is INVISIBLE to a token-count comparison, because both
 *      corpora are byte-identical — a doubled load and a single load of the same
 *      bytes report the same total. A 2026-07-22 amendment concluded "does NOT
 *      double-load" from exactly such a size comparison; that conclusion is
 *      WITHDRAWN as unsupported (`evidence-first-claims.md` MUST-3/4).
 *   2. A loom finding then reported that a DISPATCHED subagent inherits its
 *      parent's corpus and is not itself a double-load. That was an UNCONTROLLED
 *      NULL — the instrument was never shown able to display an own-root block
 *      at all, so its silence is indistinguishable from a true negative
 *      (`instrument-discipline.md` MUST-3(a)). It is WITHDRAWN and licenses NO
 *      dispatched-subagent carve-out from this guard.
 * Only a root-distinguishing instrument — an UNTRACKED sentinel at one root
 * only, with BOTH a positive and a negative control — can settle this class.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SEVERITY: why `block` and not `halt-and-report`
 * ─────────────────────────────────────────────────────────────────────────
 * `hook-output-discipline.md` MUST-2 reserves `block` for a structural /
 * behavioral / process-state signal that a surface rewrite cannot evade, and
 * forbids it for lexical regex matches over prose or shell strings.
 *
 * FOR block — the detection is a literal parameter VALUE read from the
 * structured PreToolUse JSON payload (`tool_input.isolation === "worktree"`),
 * plus, for the `EnterWorktree` route, a RESOLVED-PATH ANCESTRY FACT computed
 * with `fs.realpathSync` against git-derived boundary roots. Neither is a
 * lexical match: there is no regex over prose, no shell string to expand, and
 * no paraphrase that reaches the nested placement while evading the check —
 * the harness acts on this exact field and roots the agent at this exact
 * resolved path, so matching them IS matching the behavior. The detector
 * returns the parameter VALUE and an enumerated reason CODE, never a regex
 * match span, and carries no lexical `evidence` field.
 *
 * The `EnterWorktree` route meets the SAME bar only because it discriminates on
 * the RESOLVED TARGET PATH rather than on which KEY carries it. Keying on `name`
 * WITHOUT `path` means appending a `path` key disarms the block — a surface
 * rewrite that evades a block-grade detector, precisely what MUST-2 forbids.
 * Both routes answer the question the harm depends on ("where does this agent
 * get rooted?") instead of a question the caller can restate ("which key did you
 * use?"). Path comparison follows `security.md` § Path Containment: BOTH
 * candidate and boundary root through the SAME resolver, OS-normalized, failing
 * closed when either will not resolve.
 *
 * AGAINST block — MUST NOT § "Detectors that block work the agent has been
 * instructed to perform" warns that a hard block with no escape dead-ends
 * legitimate work. That cost is real and is answered, not dismissed, by the
 * TWO-CHANNEL override below.
 *
 * RESOLUTION — `block`, because the cost asymmetry is extreme and
 * one-directional:
 *   - A false positive costs ONE receipt file written in the same turn.
 *   - A false negative costs ~73k tokens per agent per wave, SILENTLY, on every
 *     future wave.
 * The waste is invisible at the point of the call — nothing in the agent's
 * context reveals that the corpus arrived twice. `halt-and-report` delegates the
 * final decision to an agent that cannot see the harm, and a gate whose whole
 * purpose is to surface an invisible cost cannot ask the party blind to that
 * cost to adjudicate it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OVERRIDE — two channels, both audited (worktree-isolation.md Rule 7)
 * ─────────────────────────────────────────────────────────────────────────
 * THE MECHANISM IS SHARED, NOT LOCAL (since 2026-08-23). It lives in
 * `lib/override-receipt.js::createOverrideGate` with its own bipolar fixture set
 * at `audit-fixtures/override-receipt/`. This guard was its first and only
 * implementation; `dispatch-contract-guard.js` then needed the identical
 * contract, and a second hand-written copy would have been the third
 * parser-duplication in this codebase. The behaviour below is unchanged — the
 * 35-case suite and the 13-mutant battery both still pass — but the four
 * properties that make an override audited rather than free are now defined
 * once and inherited.
 *
 *   1. RECEIPT (agent-reachable, ONE-SHOT). Write a non-empty reason to
 *      `.claude/worktree-authz/nested-worktree-allow`, then re-issue the call.
 *      The hook CONSUMES (deletes) the receipt as it honors it, so the override
 *      cannot silently disarm the gate for later calls, and the reason is echoed
 *      into the agent-visible advisory.
 *   2. ENV `COC_ALLOW_NESTED_WORKTREE=1` (operator / CI). NOT settable
 *      mid-session — a hook inherits the CLI parent's environment and a Bash
 *      `export` dies with the child shell — so an env-only override would be
 *      documented but unreachable at the moment the block fires. It is kept for
 *      harnesses and for an operator who wants the gate off for a whole run;
 *      the RECEIPT is the channel that actually answers the MUST NOT.
 *
 * Both emit an `advisory` through the canonical `emit()` shape, so the notice
 * lands in `hookSpecificOutput.additionalContext` — the ONLY agent-visible
 * channel at a non-blocking PreToolUse — rather than on stderr alone, which the
 * model never sees.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAIL-OPEN CONTRACT (cc-artifacts.md Rule 7)
 * ─────────────────────────────────────────────────────────────────────────
 * Every non-happy path — no piped stdin, empty stdin, malformed JSON, a payload
 * that is not a delegation/re-root call, or the outer timeout — passes the call
 * through with `{"continue": true}`. The guard only ever blocks on a POSITIVE
 * structural match.
 *
 * The stdin read goes through `lib/read-stdin-bounded.js::readStdinBounded`.
 * This is MANDATORY and not stylistic: a synchronous `process.stdin.read()`
 * drain at module load receives zero bytes on every invocation and therefore
 * always passes — while being registered in settings.json and reported as
 * active. An inert guard that reports green is worse than no guard.
 * `readStdinBounded` is event-driven, so the outer timer below stays live and
 * the hook cannot hang past its own budget.
 *
 * Origin: 2026-08-19 — Gate-1 ingest of a BUILD-stream structural guard loom
 * lacked entirely, genericized (language-neutral by construction; the contract
 * is "refuse a worktree placed under an ancestor `.claude/`"). Rule:
 * `worktree-isolation.md` Rule 1 (agent-wave: the orchestrator creates a SIBLING;
 * `isolation: "worktree"` and `EnterWorktree({name})` are BLOCKED) + Rule 7
 * (session/operator worktrees live in a sibling OUTSIDE the repo).
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { readStdinBounded } = require(
  path.join(__dirname, "lib", "read-stdin-bounded.js"),
);
// Every git a guard spawns routes through the shared allowlist (loom#1462/#1471,
// `security.md` § Multi-Site Kwarg Plumbing). A bare `git` resolves through PATH
// and inherits the ambient environment, and `GIT_DIR` OUTRANKS repository
// discovery — so neither `cwd:` nor `-C` pins WHICH repository answers. For this
// guard that is not cosmetic: `gitRoots()` derives the boundary roots the
// containment decision is made against, so an attacker-set `GIT_DIR` would
// re-point those boundaries at a repository of their choosing and a nested
// placement would classify as outside-any-boundary. A guard that can be aimed at
// a different repo is not a guard.
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);
// The two-channel audited override (§ OVERRIDE below) is SHARED, not local. It began here as
// the only copy; `dispatch-contract-guard.js` needed the identical contract, and a second
// hand-written copy would have been the third parser-duplication in this codebase. The four
// properties that make an override audited rather than free — agent-reachable, priced,
// one-shot, recorded — now live in ONE place with their own bipolar fixture set
// (`audit-fixtures/override-receipt/`), so a third adopter inherits them already tested.
const { safeField, createOverrideGate } = require(
  path.join(__dirname, "lib", "override-receipt.js"),
);

const HOOK_EVENT = "PreToolUse";
const RULE_ID = "worktree-isolation/nested-worktree-placement";
// Budget arithmetic, so an already-DECIDED block is never dropped by the host's
// own kill: stdin read (<=2000, readStdinBounded) + the ONE memoized git call
// (<=GIT_TIMEOUT_MS) = 3500ms worst case < this 4000ms internal fallback < the
// 5000ms `timeout: 5` registered in settings.json. The internal timer must win,
// because it fails open with a well-formed `{"continue":true}`; the host kill
// produces no output at all.
const TIMEOUT_MS = 4000;
const GIT_TIMEOUT_MS = 1500;

// The literal parameter value the harness acts on to create the nested
// worktree. Matching the value the harness reads is what makes this a
// structural signal rather than a lexical guess.
const NESTED_ISOLATION_VALUE = "worktree";

// Override channel 2 (operator / CI). NOT settable mid-session — a hook
// inherits the CLI parent's env and a Bash `export` dies with the child shell.
const ESCAPE_ENV = "COC_ALLOW_NESTED_WORKTREE";

// Override channel 1 (agent-reachable, ONE-SHOT). Repo-relative; also resolved
// against the MAIN checkout so a call issued from inside a worktree still finds
// the operator's receipt. Consumed (deleted) when honored.
const RECEIPT_REL = path.join(
  ".claude",
  "worktree-authz",
  "nested-worktree-allow",
);

// `safeField` — bound + neutralize an untrusted payload-derived string before it reaches
// stderr or `permissionDecisionReason`, both of which the agent reads back as authoritative
// text (a prompt-injection and terminal-escape vector). Now imported from
// `lib/override-receipt.js` rather than defined here: it was byte-identical to the copy the
// second consumer needed, and a sanitizer that drifts between two guards is a sanitizer that
// is wrong in one of them.

// Hard timeout fallback per cc-artifacts.md Rule 7. Deliberately longer than
// readStdinBounded's internal 2000ms bound so the reader hands back control for
// a graceful passthrough before this fires. Left REF'd so it is guaranteed to
// run even if the stdin handle drops its own ref.
let _timeoutHandle = null;

function passthrough() {
  clearTimeout(_timeoutHandle);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// The harness's nested placement, as ADJACENT path segments. Matched on the
// RESOLVED path, so this is a canonical-form segment test, not a lexical grep
// of the raw string.
const NESTED_SEGMENTS = [".claude", "worktrees"];

// darwin and win32 default to case-insensitive filesystems, so a containment
// decision that compares case-sensitively there is bypassable by re-casing.
// `security.md` § Path Containment requires the comparison be OS-normalized.
const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";

function osKey(p) {
  const n = path.normalize(p);
  return CASE_INSENSITIVE_FS ? n.toLowerCase() : n;
}

/**
 * Resolve to the REAL canonical path — symlinks followed — per
 * `security.md` § Path Containment ("never the lexical string").
 *
 * An EnterWorktree target need NOT exist yet, so a plain `realpathSync` throws
 * ENOENT on precisely the call this guard must catch. Instead: resolve the
 * DEEPEST EXISTING ancestor and re-append the not-yet-created tail. That is
 * still sound against the symlink-escape class, because a path component that
 * does not exist cannot itself be a symlink — every component that COULD
 * redirect the target is inside the resolved prefix.
 *
 * Returns null when nothing on the chain resolves; callers FAIL CLOSED on null.
 */
function realpathBounded(rawPath) {
  let abs;
  try {
    abs = path.resolve(rawPath);
  } catch {
    return null;
  }
  const tail = [];
  // Bounded so a pathological input cannot spin inside the hook's own budget.
  for (let depth = 0; depth < 128; depth++) {
    try {
      const real = fs.realpathSync(abs);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return null; // reached the root without resolving
      tail.unshift(path.basename(abs));
      abs = parent;
    }
  }
  return null;
}

/** True when `child` is STRICTLY below `parent` (equality is NOT containment). */
function isStrictlyInside(child, parent) {
  const rel = path.relative(osKey(parent), osKey(child));
  if (rel === "") return false; // the root itself is not nested inside itself
  if (rel === ".." || rel.startsWith(".." + path.sep)) return false;
  return !path.isAbsolute(rel);
}

/** True when the resolved path contains adjacent `.claude/worktrees` segments. */
function hasNestedSegments(resolvedAbs) {
  const segs = resolvedAbs
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s));
  const [a, b] = CASE_INSENSITIVE_FS
    ? NESTED_SEGMENTS.map((s) => s.toLowerCase())
    : NESTED_SEGMENTS;
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === a && segs[i + 1] === b) return true;
  }
  return false;
}

/**
 * Classify an `EnterWorktree({path})` target. Returns a reason code when the
 * RESOLVED target lands in a double-loading placement, else null.
 *
 * Discriminating on the resolved TARGET — not on which key carries it — is what
 * closes the evasion where appending a `path` key disarms a `name` block. Two
 * INDEPENDENT edges, each with its own fixture so neither masks the other's
 * mutation:
 *
 *   (A) SEGMENTS — the resolved path carries `.claude/worktrees`. Catches a
 *       nested placement under a DIFFERENT repo, which no boundary of ours
 *       contains.
 *   (B) CONTAINMENT — the resolved target is strictly inside a resolved
 *       boundary root (this repo's main checkout top, or the invoking tree's
 *       top). Catches a nested placement that does NOT use the canonical
 *       `.claude/worktrees` name.
 *
 * FAIL CLOSED (per `security.md` § Path Containment) when the target will not
 * resolve, or when no boundary root resolves at all — an undecidable
 * containment question is answered "contained", never waved through. The
 * one-shot receipt remains the escape.
 */
function classifyWorktreeTarget(rawPath) {
  const target = realpathBounded(rawPath);
  if (!target) return { code: "unresolvable-target" };

  if (hasNestedSegments(target)) return { code: "nested-segment" };

  const roots = gitRoots();
  const boundaries = [];
  if (roots) {
    // BOTH sides go through the SAME resolver; comparing a realpath'd candidate
    // against a raw root is the unsound comparison the rule names explicitly.
    for (const r of [roots.mainTop, roots.invokingTop]) {
      if (!r) continue;
      const real = realpathBounded(r);
      if (real) boundaries.push(real);
    }
  }
  if (boundaries.length === 0) return { code: "unresolvable-boundary" };

  for (const b of boundaries) {
    if (isStrictlyInside(target, b)) return { code: "inside-repo" };
  }
  return null;
}

/**
 * The tool name, reading the `payload.tool` fallback that sibling hooks accept
 * (`provenance-capture-tool.js`: `payload.tool_name || payload.tool`). A route
 * keyed on `tool_name` alone would miss the same call under the shape another
 * hook in this same directory already handles.
 */
function readToolName(payload) {
  if (typeof payload.tool_name === "string" && payload.tool_name.trim() !== "")
    return payload.tool_name;
  if (typeof payload.tool === "string" && payload.tool.trim() !== "")
    return payload.tool;
  return "";
}

/**
 * Structural predicate. Returns the matched isolation value when the payload
 * requests harness-managed (nested) worktree isolation, else null.
 *
 * The ISOLATION route is keyed on the PARAMETER, not on a tool-name allowlist,
 * per cc-artifacts.md Rule 10 (positive allowlists where the vocabulary is
 * enumerable; the enumerable vocabulary here is the isolation MODE, not the set
 * of every tool name Anthropic may ship). The settings.json MATCHER is narrow
 * because hook-event-selection.md MUST-3 forbids a `guard` from claiming `*` —
 * a tradeoff recorded honestly: a FUTURE delegation tool under a name outside
 * `Task|Agent|EnterWorktree` would carry the same flag and this hook would not
 * be invoked on it. The remedy is a one-line matcher edit, not a wider class.
 */
function detectNestedWorktreeRequest(payload) {
  if (!payload || typeof payload !== "object") return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object") return null;

  const isolation = input.isolation;
  if (
    typeof isolation === "string" &&
    isolation.trim().toLowerCase() === NESTED_ISOLATION_VALUE
  ) {
    return { kind: "isolation", value: isolation };
  }

  // Second route to the SAME nested placement: `EnterWorktree({name})` creates
  // under `.claude/worktrees/<name>`, while `EnterWorktree({path})` re-roots at
  // whatever the path names — which may be a sibling (sanctioned) or a nested
  // placement (the trap). `worktree-isolation.md` Rules 1 + 7 name both forms.
  if (readToolName(payload) === "EnterWorktree") {
    const nameVal = typeof input.name === "string" ? input.name.trim() : "";
    const pathVal = typeof input.path === "string" ? input.path.trim() : "";

    // `name` is nested BY CONSTRUCTION, and the harness's precedence when BOTH
    // keys are present is unspecified — so a `name` never clears, whatever else
    // rides alongside it. Requiring `name` WITHOUT `path` would mean appending a
    // `path` key DISARMS the block: exactly the "surface rewrite"
    // `hook-output-discipline.md` MUST-2 forbids a block-grade detector from
    // being evadable by. Remediation is to drop the `name` key, which the block
    // body states.
    if (nameVal) return { kind: "enter-worktree-name", value: nameVal };

    // Otherwise discriminate on the RESOLVED TARGET, never on which key carried
    // it. `commands/worktree.md` § 1 specifies the same predicate for callers:
    // "If a caller passes a path under $main_top or under .claude/worktrees/,
    // STOP and refuse".
    if (pathVal) {
      const verdict = classifyWorktreeTarget(pathVal);
      if (verdict)
        return {
          kind: "enter-worktree-path",
          value: pathVal,
          code: verdict.code,
        };
    }
  }

  return null;
}

/**
 * Resolve BOTH repo roots in ONE memoized git call.
 *
 *   mainTop     — the MAIN checkout top, from the SHARED .git
 *                 (`--git-common-dir`), never `--show-toplevel` (which returns
 *                 a linked worktree's OWN top and would produce a doubly-nested
 *                 suggestion). This is where `.claude/worktrees/` lives.
 *   invokingTop — the tree the call was issued from. When that is itself a
 *                 linked worktree it has its OWN `.claude/`, so a placement
 *                 nested under IT double-loads too.
 *
 * MEMOIZED because the block path needs this three times (target containment,
 * receipt candidates, remediation example) and `execFileSync` BLOCKS THE EVENT
 * LOOP — repeated calls stack their timeouts serially past the hook's own
 * fallback timer, letting the host's kill win and silently DROP an
 * already-decided block. One call, cached, keeps the worst case inside budget.
 *
 * Returns null when git is unavailable; containment then FAILS CLOSED and the
 * remediation degrades to its generic form rather than a wrong concrete path.
 */
let _gitRootsMemo; // undefined = not yet computed; null = unavailable
function gitRoots() {
  if (_gitRootsMemo !== undefined) return _gitRootsMemo;
  // An unresolvable git binary is INDETERMINATE, never a clean negative
  // (`security.md` § Enforcement-Surface Parity). Ranking it TIGHTEST here means
  // returning null, which is exactly the branch containment already FAILS CLOSED
  // on: `classifyWorktreeTarget` yields `unresolvable-boundary` and the call is
  // blocked, with the one-shot receipt remaining the escape.
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    _gitRootsMemo = null;
    return _gitRootsMemo;
  }
  try {
    const out = execFileSync(
      gitBin,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
        // A SYNC subprocess blocks the event loop, so the outer setTimeout
        // cannot fire while it runs; SIGTERM-ignoring git would hold the hook
        // until the host's own 5s kill (which fails open and would silently
        // DROP an already-decided block). SIGKILL makes the bound real.
        killSignal: "SIGKILL",
        // Explicit minimal env built from constants — nothing inherited, so the
        // whole `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG_*` steering family is
        // closed by construction rather than enumerated.
        env: gitEnv(),
      },
    );
    const lines = String(out)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      _gitRootsMemo = null;
      return _gitRootsMemo;
    }
    _gitRootsMemo = {
      mainTop: path.dirname(lines[0]), // shared .git's parent
      invokingTop: lines[1] || null,
    };
  } catch {
    _gitRootsMemo = null;
  }
  return _gitRootsMemo;
}

/**
 * The sanctioned sibling worktree parent: `<main-parent>/.<slug>-wt`, derived
 * exactly as `commands/worktree.md` § 1 derives it. Used only to render the
 * remediation example.
 */
function resolveSiblingRoot() {
  const roots = gitRoots();
  if (!roots) return null;
  const { mainTop } = roots;
  const slug = path.basename(mainTop);
  return path.join(path.dirname(mainTop), `.${slug}-wt`);
}

/**
 * The shared two-channel override gate, memoized.
 *
 * `extraRoots` supplies the MAIN checkout alongside the invoking tree: the agent writes the
 * receipt where it is WORKING (possibly a sibling worktree) while an operator may drop it in
 * the main checkout, and resolving only one of the two makes the override unreachable for the
 * other — the same "documented but unreachable" defect an env-only channel has. It is a
 * CALLBACK precisely so `gitRoots()` (a synchronous subprocess) is spawned only on the path
 * that actually looks for a receipt.
 */
let _gateMemo;
function overrideGate() {
  if (_gateMemo !== undefined) return _gateMemo;
  _gateMemo = createOverrideGate({
    receiptRel: RECEIPT_REL,
    envVar: ESCAPE_ENV,
    extraRoots: () => {
      const roots = gitRoots();
      return roots && roots.mainTop ? [roots.mainTop] : [];
    },
  });
  return _gateMemo;
}

/** Retained as a named export: the fixture harness resolves the receipt path through it. */
function receiptCandidates() {
  return overrideGate().receiptCandidates();
}

function emitOverrideAdvisory({ channel, detail, toolName, matched }) {
  clearTimeout(_timeoutHandle);
  emit({
    hookEvent: HOOK_EVENT,
    severity: "advisory",
    what_happened:
      `Nested-worktree placement PERMITTED by ${channel} for this ${toolName} call ` +
      `(${matched.kind}="${matched.safeValue}"). ${detail}`,
    why:
      `${RULE_ID} — the override was honored, not the gate. That agent will load loom's ` +
      `matching path-scoped rules TWICE (~292 KB / ~73k tokens per .claude/rules/** touch, ` +
      `measured 2026-07-26). This notice exists so the cost is visible rather than silent.`,
    agent_must_report: [
      `State in your next message that the nested-worktree gate was overridden via ${channel}, and why.`,
      `Confirm this was intentional; if not, cancel the delegation and use a sibling worktree instead.`,
    ],
    agent_must_wait:
      "You may proceed — this is advisory, not a block. Surface the override in your report.",
    user_summary: `${RULE_ID} — nested worktree ALLOWED via ${channel} (~73k tok/agent)`,
  });
  // emit() exits; unreachable.
}

// Why the RESOLVED target was judged nested, in the agent's terms. Keyed on the
// reason code so the report says which edge fired rather than a generic "nested".
const TARGET_REASON = {
  "nested-segment":
    "its RESOLVED target lands under a `.claude/worktrees/` directory",
  "inside-repo":
    "its RESOLVED target lands INSIDE this repo's own tree (symlinks followed — a " +
    "lexically-outside path can still resolve back in)",
  "unresolvable-target":
    "its target could not be resolved to a real path, so containment could not be " +
    "decided and the check FAILS CLOSED (security.md § Path Containment)",
  "unresolvable-boundary":
    "no repo boundary root could be resolved (git unavailable), so containment could " +
    "not be decided and the check FAILS CLOSED (security.md § Path Containment)",
};

function emitBlock({ toolName, matched, siblingExample }) {
  const isNameForm = matched.kind === "enter-worktree-name";
  const isPathForm = matched.kind === "enter-worktree-path";
  const requested = isNameForm
    ? `EnterWorktree({name: "${matched.safeValue}"})`
    : isPathForm
      ? `EnterWorktree({path: "${matched.safeValue}"})`
      : `\`isolation: "${matched.safeValue}"\``;

  // The `name` form is nested by construction whatever else rides alongside it;
  // stating that here is what keeps the block from reading as "drop the name and
  // it will pass" when the accompanying path is ALSO nested.
  const placement = isPathForm
    ? `The call was judged nested because ${TARGET_REASON[matched.code] || "its RESOLVED target is a nested placement"}. ` +
      `An agent rooted there loads the matching path-scoped rules corpus TWICE (its own .claude/rules/ ` +
      `AND the ancestor repo's).`
    : `The harness would create the worktree at <repo>/.claude/worktrees/ — NESTED inside this ` +
      `repo, directly under the repo's own .claude/. An agent rooted there loads the matching ` +
      `path-scoped rules corpus TWICE (its own .claude/rules/ AND the ancestor repo's).` +
      (isNameForm
        ? ` A \`name\` is nested BY CONSTRUCTION, so adding a \`path\` key alongside it does NOT ` +
          `clear this block — drop the \`name\` and pass a SIBLING \`path\` instead.`
        : "");

  emit({
    hookEvent: HOOK_EVENT,
    severity: "block",
    what_happened: `${toolName} call requested ${requested}. ${placement}`,
    why:
      `${RULE_ID} — measured at loom 2026-07-26 (CC 2.1.220, untracked-sentinel probe, 2/2 runs, ` +
      `with a negative control): a nested-rooted session loaded the same path-scoped rule TWICE under ` +
      `two distinct paths and received an ancestor-ONLY rule in full, while a SIBLING-rooted session ` +
      `loaded each exactly once. Loom's corpus is 74 path-scoped rules / 1,185,700 B; a single ` +
      `.claude/rules/** touch matches ~13 of them (~292 KB, ~73k tokens) which a nested root pays ` +
      `TWICE. Per-touch digits are indicative (reimplemented glob matcher); the duplication is ` +
      `measured. A sibling worktree outside the repo has no ancestor .claude/ and is structurally immune.`,
    agent_must_report: [
      `Quote the blocked call: tool=${toolName}, ${matched.kind}="${matched.safeValue}".`,
      `REMEDIATION (preferred) — create a SIBLING worktree and give the agent its ABSOLUTE path, ` +
        `instead of ${isNameForm ? "EnterWorktree({name})" : isPathForm ? "this nested path" : 'isolation:"worktree"'}:\n` +
        `      git worktree add -b <branch> "${siblingExample}" origin/main\n` +
        `    then ${isNameForm || isPathForm ? `EnterWorktree({path: "${siblingExample}"}) with NO \`name\` key` : "dispatch the agent WITHOUT the isolation flag, pinning that ABSOLUTE path in the prompt"} ` +
        `and mandate the STEP-0 assertion worktree-isolation.md Rule 1(b) requires: cd into the ` +
        `worktree FIRST, then assert \`git rev-parse --show-toplevel\` equals \`pwd -P\` and is NOT ` +
        `the main checkout, refusing on mismatch.`,
      `OVERRIDE (if the nested placement is genuinely required) — write a one-line reason to ` +
        `${RECEIPT_REL} and re-issue this exact call. The receipt is CONSUMED on use (one-shot) and ` +
        `the override is surfaced back to you as an advisory. Do NOT file a follow-up issue instead ` +
        `of remediating (autonomous-execution.md § Per-Session Capacity Budget Rule 4).`,
    ],
    agent_must_wait:
      `Do not retry this call unmodified. Either switch to a sibling worktree (preferred) or write ` +
      `the one-shot receipt at ${RECEIPT_REL} and retry.`,
    user_summary: `${RULE_ID} — blocked nested worktree (${matched.kind}="${matched.safeValue}") on ${toolName}; ~73k tok/agent double-load`,
  });
  // emit() exits; unreachable.
}

async function main() {
  // fallback:null distinguishes a FAILED/EMPTY read from a genuine `{}` payload.
  // Both pass through (fail-open per cc-artifacts.md Rule 7), but keeping them
  // distinguishable is what makes the inert-hook class testable rather than
  // invisible.
  const payload = await readStdinBounded({ timeoutMs: 2000, fallback: null });
  if (payload === null) return passthrough();

  const hit = detectNestedWorktreeRequest(payload);
  if (!hit) return passthrough();

  // Every payload-derived string is bounded + control-char-stripped BEFORE it
  // reaches stderr or `permissionDecisionReason`, both of which the agent reads
  // back as authoritative text (prompt-injection / terminal-escape vector).
  const toolName = safeField(readToolName(payload), "<unknown>");
  const matched = {
    kind: hit.kind,
    safeValue: safeField(hit.value, "?"),
    // Internal reason code — enumerated by THIS file, never payload-derived, so
    // it needs no sanitizing and cannot forge a marker.
    code: hit.code,
  };

  // BOTH override channels, resolved by the shared gate. Env is checked FIRST inside it, so a
  // CI run cannot silently spend an agent's one-shot receipt written for a later call.
  const override = overrideGate().resolveOverride();
  if (override) {
    return emitOverrideAdvisory({
      channel: override.channel,
      detail: override.reason
        ? `${override.detail} Stated reason: ${safeField(override.reason, "(none)")}`
        : override.detail,
      toolName,
      matched,
    });
  }

  // Resolve the remediation path BEFORE disarming the fallback timer: the git
  // call is synchronous, and a stall after clearTimeout would drop the block.
  const siblingRoot = resolveSiblingRoot();
  const siblingExample = siblingRoot
    ? path.join(siblingRoot, "<name>")
    : "<main-repo-parent>/.<repo-slug>-wt/<name>";

  clearTimeout(_timeoutHandle);
  emitBlock({ toolName, matched, siblingExample });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). A require() arms nothing, so
// there is no timer to clear on the required path.
function hookMain() {
  _timeoutHandle = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  return main().catch(() => {
    // Any unexpected throw fails OPEN per cc-artifacts.md Rule 7 — a guard must
    // never wedge the session on its own defect.
    passthrough();
  });
}

module.exports = {
  detectNestedWorktreeRequest,
  classifyWorktreeTarget,
  realpathBounded,
  isStrictlyInside,
  hasNestedSegments,
  readToolName,
  gitRoots,
  resolveSiblingRoot,
  receiptCandidates,
  safeField,
  NESTED_ISOLATION_VALUE,
  NESTED_SEGMENTS,
  ESCAPE_ENV,
  RECEIPT_REL,
  RULE_ID,
  hookMain,
};

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
