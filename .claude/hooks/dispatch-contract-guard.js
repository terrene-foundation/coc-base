#!/usr/bin/env node
/**
 * dispatch-contract-guard.js — the ENFORCING half of the dispatch contract.
 *
 * Complements, and deliberately does NOT duplicate, the T1 telemetry pair
 * (`emit-dispatch-ledger.js` + `reconcile-dispatch-delivery.js`). Those RECORD what happened and
 * reconcile it at `SubagentStop` — after the lane has already run. This one inspects the dispatch
 * BEFORE it is issued, at the only moment the brief and the requested agent type are both present
 * and the dispatch is still cheap to fix. The T1 reconciler tells you a lane went idle; this tells
 * you the brief was going to make it go idle.
 *
 * @hook-event: PreToolUse:Task|Agent|Workflow (guard) — the dispatch IS the subject: the brief, the dispatch
 *   NAME, the requested subagent type and the requested effort live in `tool_input` at this moment
 *   and nowhere else, and this is the last instant before a mis-briefed lane consumes a full agent
 *   turn. The matcher is exactly the delegation-tool set; a `*` matcher would pay a node spawn on
 *   every Read/Bash/Grep to reach an immediate passthrough, and `hook-event-selection.md` MUST-3
 *   FAILs a narrow class registered without a matcher.
 *
 * THE RE-TASK ARM RUNS FROM A SEPARATE ENTRY, `dispatch-retask-guard.js`, registered on
 * `PreToolUse:SendMessage` with `on_incomplete: "continue"` — this file's row stays `deny`. The
 * split is the point: SendMessage is every lane's delivery channel, so a guard that cannot FINISH on
 * a follow-up (a crash, or an overrun of the registered budget on a loaded host) must let the message
 * through, while a launch the guard cannot finish must not run. One file cannot carry both
 * declarations — `lib/dispatch-registry.js::assertNoDivergentDuplicateRows` refuses one hook declared
 * twice with different `on_incomplete` values — so the re-task entry is a second file that reads its
 * own payload, keeps its own fail-open run boundary, and runs this module's `evaluateRetask`.
 *
 * WORKFLOW CALLS ARE JUDGED HERE TOO (finding ROOT-W1). An agent the Workflow tool spawns — an
 * `agent(prompt, {effort, …})` call in its script — fires NO PreToolUse `Task|Agent` (MEASURED
 * 2026-10-12: the dispatch ledger held a launch row for a plain Agent control and none for two
 * workflow agents), so the `Workflow` call is the one place those launches can be routed. This entry
 * is registered on `Task|Agent|Workflow`; for a Workflow it resolves EXACTLY ONE script source
 * (`script`, an absolute no-follow `scriptPath`, or a saved `name`), PROVES what the script launches
 * (`lib/workflow-launch-scan.js` — every occurrence of `agent`/`workflow` must be a direct call, every
 * region classifiable without guessing), and judges each literal call exactly as a launch
 * (`lib/effort-routing.js::decideWorkflowLaunch`): a literal fault BLOCKS with the corrected line and
 * effort; anything it cannot prove — an aliased, mapped, member, escaped or reflective use of the hook,
 * a call inside a `${…}`, an ambiguous `/`, a non-literal prompt or effort, a nested workflow(), two
 * sources, an empty script, a relative or unreadable path — BLOCKS too, fail-closed (root ruling and E3
 * R2 security, 2026-10-12), telling the agent how to make it literal; and a library that will not load,
 * or this guard throwing mid-judgement, blocks with the restore text. The workdir
 * contract predicates do not apply to a Workflow call; the receipt digest binds its resolved script.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THREE SEVERITY TIERS, AND WHY THE LINES FALL WHERE THEY DO
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `hook-output-discipline.md` MUST-2 reserves `block` for a structural signal a surface rewrite
 * cannot evade, and FORBIDS it for a lexical match over prose. This hook carries both kinds, so it
 * carries graded tiers — stated explicitly rather than left implied, per MUST-5(b):
 *
 *   ADVISORY (never blocks; never spends or offers a receipt) — `wip-discipline` MUST-9.
 *     `detectLaneBriefWithoutPartition` reads a lane-orchestrator brief for the fan-out /
 *     partition instruction (`journal/0607` decisions 1–2, delivered at dispatch time per
 *     `journal/0608` item 6). Every half is prose, and the miss costs throughput rather than a
 *     wasted turn, so it sits BELOW halt-and-report.
 *
 * All non-block findings render in ONE response through `lib/instruct-and-wait.js::emit` at the
 * `pre-action` register (see `emitNonBlocking`), so two predicates on one brief never double-fire.
 *
 *   HALT-AND-REPORT (never blocks; never spends or offers a receipt) —
 *     `orchestrator-context-economy` MUST-5 + MUST-6.
 *     MUST-6 reads the brief for a push-delivery instruction; MUST-5 reads it for write intent.
 *     MUST-5's OTHER half (the target agent's declared `tools:` frontmatter) is a parsed document
 *     field and would be fencing-grade alone, but a detector is no stronger than its weakest half,
 *     so the composed finding is CAPPED. This tier can annotate a bad dispatch; it can never stop
 *     one. Promoting it would be a MUST-2 violation.
 *
 *   BLOCK — `agents/worktree-orchestration-absolute-path-pin`.
 *     The verdict is `fs.existsSync` on an absolute path the brief names as the lane's working
 *     directory: a filesystem FACT, the exact class MUST-2 names as block-grade. The prose half
 *     here is only a SCOPE GATE (which token to test), not the verdict — so the "weakest half"
 *     reasoning that caps the tier above does not transfer. Full argument in
 *     `lib/dispatch-contract.js` § (c). When EVERY lane root the brief names is a pure
 *     `<placeholder>` (no absolute component), nothing was measured, so this rule arrives at
 *     ADVISORY instead; any absolute lane root, existing or not, keeps the block.
 *
 *   BLOCK — `agents/effort-routing` (owner decision 2026-10-12; `lib/effort-routing.js`).
 *     Every launch carries the effort its ROLE maps to in `lib/effort-routing-policy.json`. The
 *     verdict compares three PARSED fields — the brief's first-line `ROLE: <role>`, the schema-
 *     checked table, and the launch's own `effort` parameter (Codex `reasoning_effort`, normalized
 *     in `lib/codex-hook-runtime.js::normalizeNativeInput`) — so it is block-grade under MUST-2.
 *     On `SendMessage` (the `dispatch-retask-guard.js` entry) it blocks a RE-TASK whose ROLE needs a
 *     different effort than the T1 dispatch ledger recorded at launch, and every re-task finding is
 *     ADVISORY when that launch effort is unknown. Its own override is the brief's
 *     `EFFORT-OVERRIDE: <level> — <reason>` line, RECORDED in the shared override use ledger
 *     (`lib/override-receipt.js::recordInlineOverride`) and refused when it cannot be recorded. The
 *     one-shot receipt below also lifts it, and its call digest binds the launch's effort value; the
 *     operator/CI ENV channel does NOT — that channel is session-wide and unledgered
 *     (`lib/override-receipt.js::createOverrideGate` § envOverride), so an effort block is lifted only
 *     by a per-call, recorded override.
 *     THIS ARM FAILS CLOSED on a launch — the one exception to the fail-open stance below, by owner
 *     decision: an invalid or absent table, a missing or malformed role line, an unknown role, a
 *     missing effort, a `fork` launch with no override line, and an effort-routing library that will
 *     not load all BLOCK. It needs none of this guard's other libraries to decide, so it is evaluated
 *     BEFORE they load: an unloadable `lib/dispatch-contract.js` or `lib/override-receipt.js`, an
 *     unconstructable override gate, or an unloadable `lib/instruct-and-wait.js` still BLOCKS an
 *     effort finding (the last through a hand-built deny, `hardDeny`); only the override channel is
 *     lost, and an effort block always keeps its in-band remedy (set the routed effort). An
 *     unparseable or oversized payload no longer passes: the run boundary REFUSES it
 *     (`lib/guard-runner.js::readPayload`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE OVERRIDE — why this hook grew one, and what it is actually fixing
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * DETECTION WAS NEVER THE GAP. On the originating incident the MUST-5 finding FIRED, correctly, on
 * a brief that demanded file mutation from a read-only agent. The orchestrator answered "right as
 * issued — the brief is read-only", which was FALSE (the brief also demanded a bipolar control
 * requiring a mutation). The lane ran ~119k tokens and delivered nothing. Overriding a correct
 * finding cost NOTHING and left NO RECORD.
 *
 * So the BLOCK tier routes through the shared audited-override gate in `lib/override-receipt.js`:
 * a REASON written to a one-shot receipt (agent-reachable), or an operator/CI env var. The receipt
 * is BOUND to the one blocked dispatch — its digest covers the tool name, the subagent type, the
 * prompt and the blocking finding ids (`lib/override-receipt.js` § THE CALL DIGEST) — expires
 * fifteen minutes after its own `written_at`, is CONSUMED as it is honoured, and each use appends
 * one row to the shared use ledger in the MAIN checkout; the stated reason is ECHOED into
 * agent-visible context. A receipt written for another dispatch, a stale one, or a malformed one is
 * refused BY NAME and left in place. A BLOCK response renders EVERY finding on the brief, each
 * under its own class (`renderFindingLines`), so a MUST-6 or MUST-9 line riding on a blocked brief
 * is not hidden behind the block.
 *
 * THE NON-BLOCK TIERS NEVER TOUCH THE RECEIPT, neither consuming nor offering it (2026-09-12). An
 * earlier revision resolved the override for `halt-and-report` findings too and offered the receipt
 * there, reasoning that the originating incident was a waved-past halt-and-report and a receipt
 * RECORDS the wave. That was a misbinding, because the receipt then named no call: a dispatch this
 * hook cannot stop SPENT a receipt an operator had written for a blocked call, echoed that reason
 * against the wrong dispatch, and left the blocked call with no override. The record for a
 * halt-and-report is the one-line reason its response requires in the agent's next message. The
 * receipt was ALSO unbound among block-class calls until 2026-10-10 (one written for one blocked
 * dispatch lifted whichever blocked dispatch arrived first); the call digest closes that, in the
 * shared lib, for all four consuming guards at once.
 *
 * THE CONTRACT PREDICATES FAIL OPEN ON AN UNKNOWN THEY ANSWER — EXCEPT the effort-routing arm,
 * which fails closed by owner decision (see its tier above). Unreadable agents dir, agent type with
 * no file (`general-purpose`, `Explore`, every other built-in), missing `tools:` line, no absolute
 * path named, an `existsSync` that throws — each is a predicate that cannot measure, and returns
 * `{continue:true}`: a guard that guesses when it cannot see is one the orchestrator learns to
 * ignore. A LAUNCH RUN THAT REACHES NO VERDICT AT ALL is a different thing and does not pass: an
 * unreadable payload (empty, unparseable, oversized, or a stdin that never ends), the guard
 * throwing, or a run past its budget is refused by `lib/guard-runner.js::runGuard`, because this
 * row is `on_incomplete: deny` (`cc-artifacts.md` Rule 7). In the engine the dispatcher is the one
 * refusal authority for those endings; standalone the runner exits 2 naming this guard. The
 * re-task entry (`dispatch-retask-guard.js`, `on_incomplete: continue`) keeps `{continue:true}`
 * on all three.
 *
 * Receipt honouring claims and records the receipt, then cleans up private custody; failed recording
 * restores original inode bytes without clobbering a newer receipt (.claude/hooks/lib/override-receipt.js:656-685,896-1005).
 * It appends one row to `<main checkout>/.claude/learning/override-receipt-uses.jsonl`
 * — on a dispatch carrying a block-class finding whose receipt matches it, and on a call whose
 * `EFFORT-OVERRIDE:` line is honoured. The row holds the call digest, a HASH of the reason and the
 * consumer's session/agent identity: no prompt text is retained; findings go to the advisory
 * surface with bounded, sanitized evidence. The dispatch-ledger sink is T1's job: this hook only
 * READS it, on a `SendMessage` whose message declares a ROLE, to learn the recipient's launch effort.
 *
 * DEGRADES SAFELY WHERE THE AGENT CORPUS IS ABSENT. `.claude/hooks/**` is ALWAYS_INCLUDE so this
 * ships to every consumer; a consumer with no `.claude/agents/` yields an empty inventory, every
 * MUST-5 lookup is UNKNOWN, and the MUST-6 + workdir arms stay live. That is degradation to a
 * smaller true answer, never to a false clean.
 *
 * Origin: co-owner-directed origination 2026-08-16 (`orchestrator-context-economy.md` § Origin);
 * the blocking tier + the audited override added 2026-08-23 after the override-costs-nothing
 * incident above and a sibling incident in the same session — an agent dispatched at a worktree
 * path that did not exist, which no guard checked.
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       ".claude/dispatch-authz/dispatch-contract-allow",
 *       ".claude/dispatch-authz/.override-claim-<mkdtemp>/receipt",
 *       "<main-checkout>/.claude/learning/override-receipt-uses.jsonl"
 *     ],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false,
 *   "notes": "On a block-class call with a matching, unexpired receipt, consumption renames the public receipt into a private same-parent 0700 `.override-claim-<mkdtemp>/receipt`, validates the claimed bytes, records the use under the main checkout, then cleans up the private claim. Validation or recording failure restores the original inode bytes without overwriting a newer public receipt; a collision retains private custody and reports refusal. Recorded cleanup failure never rearms the public receipt. Source: .claude/hooks/lib/override-receipt.js:656-685,896-1005. An honoured EFFORT-OVERRIDE brief line appends one inline row to the same use ledger (lib/override-receipt.js::recordInlineOverride). The consumed receipt cannot authorize a repeat payload, so idempotent is false. spawns: the git probe lib/append-sink.js::mainCheckoutBoundaryRoots makes (via lib/state-resolver.js) to find the main checkout, on the receipt-honour and EFFORT-OVERRIDE-record paths, and the lib/state-resolver.js::requireMainCheckout probe on a SendMessage whose message declares a ROLE (to read the T1 dispatch ledger); lib/dispatch-contract.js and lib/effort-routing.js spawn nothing."
 * }
 */

"use strict";

// The run budget, deliberately under the registered 5s timeout. For the LAUNCH entry it is the
// standalone budget `lib/guard-runner.js::runGuard` enforces (in the engine the row's own timeout
// bounds the run); the RE-TASK entry arms its own fail-open timer at the same value
// (`dispatch-retask-guard.js`). The common path spawns no subprocess: a shallow agents-dir walk, a
// few `existsSync` calls and one small table read. A git probe runs only on an override-record or
// receipt-honour path and on a ROLE-declaring SendMessage (ledger lookup, bounded by
// LEDGER_SAFETY_MS below), so 4000ms holds.
const BUDGET_MS = 4000;
/** Held back from `BUDGET_MS` for the ledger read and the response after a re-task's git probe. */
const LEDGER_SAFETY_MS = 1200;
/** Set per run in `beginRun` — the in-process engine requires this module once per worker. */
let STARTED_AT = Date.now();
/** The launch tool this run is judging, for the incomplete-check refusal's wording only. */
let launchTool = null;

const fs = require("node:fs");
const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { runGuard } = require("./lib/guard-runner.js");

function passthrough(context) {
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/**
 * One line per finding, each under its OWN severity class. The single renderer every response in
 * this hook uses — block, override notice, non-block, and fallback — so no path can list a subset.
 */
function renderFindingLines(findings) {
  return findings.map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`).join("\n");
}

/** Render the advisory emitted when an override was honoured. The RECORD. */
function renderOverrideNotice(override, findings, gate) {
  const lines = [
    "⚠ Dispatch-contract gate OVERRIDDEN — the override was honoured, not the gate.",
    "",
    gate.formatOverrideLine(override),
    "",
    "Findings present on the overridden dispatch (the override lifted the [block] line only):",
    renderFindingLines(findings),
  ];
  lines.push("");
  lines.push(
    "State in your next message that this gate was overridden and why. If the override was a " +
      "mistake, cancel the dispatch now — it has not been corrected, only permitted.",
  );
  return lines.join("\n");
}

/**
 * Judge ONE parsed payload under ONE entry's scope. `payload` is the PARSED payload, never raw text
 * (an earlier revision called `JSON.parse()` on an already-parsed value, threw on every well-formed
 * input and made this hook silently inert; it was caught by driving the real stdin boundary, never
 * by the library fixtures, which do not exercise this seam). The LAUNCH entry receives it from
 * `guard-runner.js::runGuard`, which never hands over a default; the RE-TASK entry from its own reader.
 */
async function evaluate(scope, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const tool = p.tool_name || p.tool || "";

  // The tool set of each entry's matcher, declared HERE rather than read from a library, so an
  // unloadable library cannot shrink what this guard recognizes as a launch. The launch entry
  // (`hookMain`, `Task|Agent`) and the re-task entry (`dispatch-retask-guard.js`, `SendMessage`)
  // each act ONLY on their own tools, so the two registrations never judge one call twice.
  const isLaunch = scope === "launch" && LAUNCH_TOOLS.includes(tool);
  const isRetask = scope === "retask" && RETASK_TOOLS.includes(tool);
  // A Workflow call is judged by the LAUNCH entry: its script's agent() launches fire no PreToolUse
  // of their own (finding ROOT-W1), so this call is the only place they can be routed.
  const isWorkflow = scope === "launch" && tool === WORKFLOW_TOOL;
  if (!isLaunch && !isRetask && !isWorkflow) return passthrough(null);
  // Launch-shaped for rendering and the override channel: a Workflow call is a batch of launches.
  const launchLike = isLaunch || isWorkflow;

  // EFFORT ROUTING (`lib/effort-routing.js`) — FIRST, because it needs none of the libraries below
  // and FAILS CLOSED on a launch: a library missing below must not be able to skip it. A follow-up
  // that declares no ROLE is not a re-tasking declaration and returns before any ledger IO.
  if (launchLike) launchTool = tool;
  const effort = isWorkflow ? evaluateWorkflowRouting(p) : evaluateEffortRouting(tool, p, isLaunch);

  let lib = null;
  let overrideLib = null;
  try {
    lib = require(path.join(__dirname, "lib", "dispatch-contract.js"));
  } catch {
    lib = null; // the contract predicates and the receipt path are lost; the effort arm is not
  }
  try {
    overrideLib = require(path.join(__dirname, "lib", "override-receipt.js"));
  } catch {
    overrideLib = null; // no override channel: an EFFORT-OVERRIDE cannot be recorded, so it is refused
  }

  let findings = [];
  if (isLaunch && lib) {
    try {
      const inventory = lib.readAgentInventory(PROJECT_DIR);
      findings = lib.inspectDispatch(tool, p.tool_input, inventory);
    } catch {
      // The contract predicates fail OPEN on an unknown, as they always have; the effort arm above
      // has already been evaluated and is the one arm here that fails closed.
      findings = [];
    }
  }
  if (effort !== null) {
    let effortFindings = effort.findings;
    if (effort.override) effortFindings = recordEffortOverride(effort, tool, p, overrideLib);
    // A Workflow's honoured overrides are recorded ONE ROW PER agent() call, each bound to that
    // call's own prompt and effort — honoured ⇔ recorded, exactly as for a single launch.
    for (const o of effort.overrides || []) {
      const one = { findings: [], override: o };
      const callP = { ...p, tool_input: { prompt: o.prompt, effort: o.level } };
      effortFindings = effortFindings.concat(recordEffortOverride(one, tool, callP, overrideLib));
    }
    findings = findings.concat(effortFindings);
  }

  if (findings.length === 0) return passthrough(null);

  const blocking = findings.filter((f) => f.severity === "block");

  // NO BLOCK-CLASS FINDING ⇒ NO OVERRIDE GATE, on EVERY non-block tier — `advisory` AND
  // `halt-and-report`. There is nothing to override on a call this hook does not stop. The
  // receipt is now bound to one call by digest (`lib/override-receipt.js::callDigestOf`), so a
  // non-block call could not SPEND a receipt written for a blocked one even if it asked — but it
  // would still READ it and report a digest mismatch against a call that has nothing to lift, so
  // the gate is not consulted here at all.
  if (blocking.length === 0) {
    return emitNonBlocking(tool, findings, launchLike);
  }

  const workdirBlocks = blocking.filter((f) => f.rule_id !== EFFORT_RULE_ID);
  const effortBlocks = blocking.filter((f) => f.rule_id === EFFORT_RULE_ID);

  // THE OVERRIDE CHANNEL. Without one, a WORKDIR block degrades to a report (fail-open, as it always
  // has: never a block the agent has no way to lift); an EFFORT block still blocks, because its
  // remedy is in-band — set the routed effort, or the recorded EFFORT-OVERRIDE line — so losing the
  // receipt channel never leaves the agent without a way forward.
  let gate = null;
  let digest = null;
  let unavailable = null;
  if (!lib || !overrideLib) {
    unavailable = "the override library could not be loaded";
  } else {
    // THE CALL DIGEST — what a receipt must name to lift THIS dispatch: the tool, the subagent
    // type, the prompt, and the ids of the findings that block it, an effort finding's id carrying
    // the effort value the launch requested (`bindingIdOf`). Null only when the tool_input cannot
    // be digested, in which case no receipt can lift it and the block stands.
    digest = overrideLib.callDigestOf(tool, digestInputOf(p, isWorkflow, effort), blocking.map((f) => bindingIdOf(f, p, isLaunch)));
    // The gate is constructed ONLY once a block-class finding exists — construction is cheap, but
    // `resolveOverride` CONSUMES a receipt, and a receipt must only ever be spent on the call it can lift.
    try {
      gate = overrideLib.createOverrideGate({
        receiptRel: lib.OVERRIDE_RECEIPT_REL,
        envVar: lib.OVERRIDE_ENV,
        // The MAIN project root as well as the invoking cwd, so an operator's receipt is found even
        // when the call is issued from inside a linked worktree. `CLAUDE_PROJECT_DIR` is already
        // resolved for us, so this needs no git subprocess and the hook's budget is untouched.
        extraRoots: () => [PROJECT_DIR],
      });
    } catch {
      gate = null;
      unavailable = "the override channel is unavailable";
    }
  }
  if (!gate && effortBlocks.length === 0) {
    return passthrough(renderFallback(findings, `${unavailable}, so the block degrades to this report`));
  }

  if (gate) {
    // Reached ONLY with a block-class finding present (the `blocking.length === 0` return above).
    // Env is checked before the receipt inside the gate, so a CI run cannot silently spend the
    // agent's one-shot receipt; a receipt bound to a DIFFERENT dispatch is refused by name and left
    // in place. With an EFFORT block present the env channel is NOT consulted (`env: {}`): it is
    // session-wide and writes no ledger row, and an effort block is lifted only per call, recorded —
    // the receipt row then carries the effort the call requested (`detail`).
    const override = gate.resolveOverride(
      effortBlocks.length > 0
        ? { digest, consumer: overrideLib.consumerOf(p), env: {}, detail: effortReceiptDetail(tool, p, isLaunch, effortBlocks) }
        : { digest, consumer: overrideLib.consumerOf(p) },
    );
    if (override) {
      return passthrough(renderOverrideNotice(override, findings, gate));
    }
  }

  {
    // Load `emit` lazily: it is needed on the rendering paths only, and the clean and off-matcher
    // paths in this hook must stay free of its module cost. A renderer that will not load is a
    // VERDICT INPUT recorded in the catch and decided OUTSIDE it (no decision is made in an error
    // handler): a WORKDIR-only block degrades to a plain report, as it always has; an EFFORT block
    // is refused through the hand-built deny that needs no renderer, because that arm fails closed.
    // A throw FROM the renderer, once loaded, is not caught here: it reaches the run boundary.
    let emit = null;
    try {
      ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
    } catch {
      emit = null;
    }
    if (typeof emit !== "function") {
      if (effortBlocks.length > 0) return hardDeny(tool, launchLike, findings, "renderer unavailable");
      return passthrough(renderFallback(findings, "renderer unavailable"));
    }
    const nonBlocking = findings.length - blocking.length;
    const what = [];
    if (workdirBlocks.length > 0) what.push("names a working directory that does not exist");
    if (effortBlocks.length > 0) what.push("does not carry the effort its ROLE routes to");
    const why = [];
    const report = [];
    const remedy = [];
    if (workdirBlocks.length > 0) {
      why.push(
        "agents.md § Worktree Orchestration — the ORCHESTRATOR creates the worktree and pins its " +
          "ABSOLUTE path in the prompt. A path that is absent at dispatch time cannot become present " +
          "for the lane: its STEP-0 assertion refuses, and the whole agent turn is spent discovering " +
          "that. Unlike this hook's other findings, this verdict is `fs.existsSync` — a filesystem " +
          "fact, which hook-output-discipline.md MUST-2 names as block-grade.",
      );
      report.push(
        `Quote the blocked dispatch and the missing path(s): ${workdirBlocks
          .flatMap((f) => f.missing || [])
          .map((m) => (overrideLib ? overrideLib.safeField(m, "?") : String(m).replace(/[^\x20-\x7e]/g, "?").slice(0, 80)))
          .join(", ")}.`,
        "REMEDIATION (preferred) — create the worktree/directory FIRST, then re-issue with the " +
          "path that now exists:\n" +
          "      git worktree add -b <branch> <ABSOLUTE-sibling-path> <base-ref>\n" +
          "    and keep the STEP-0 assertion in the brief (cd first, then assert " +
          "`git rev-parse --show-toplevel` equals `pwd -P`, refusing on mismatch).",
      );
      remedy.push("create the path first (preferred)");
    }
    if (effortBlocks.length > 0) {
      why.push(
        "Effort routing (owner decision 2026-10-12; skills/30-claude-code-patterns/" +
          "specialist-delegation-syntax.md § Effort Routing) — every subagent launch carries the " +
          "effort the routing table .claude/hooks/lib/effort-routing-policy.json assigns to its ROLE, " +
          "because the per-dispatch effort parameter IS honoured and decides what the lane can do. The " +
          "verdict compares parsed fields only — the brief's first-line `ROLE: <role>`, the schema-checked " +
          "table and the call's `effort` parameter — which hook-output-discipline.md MUST-2 names as " +
          "block-grade, and it FAILS CLOSED.",
      );
      report.push(
        `Quote the blocked call and each ${EFFORT_RULE_ID} finding above (its code names what is wrong).`,
        isWorkflow
          ? "REMEDIATION (preferred, no human step needed) — edit the Workflow script: give each agent() " +
              "call the finding names a literal prompt whose FIRST line is exactly the corrected `ROLE: <role>` " +
              "line, and the literal option `{effort: \"<level>\"}` the finding names; then re-issue the Workflow. " +
              "Each finding names its call's script line, every valid role, and the roles a generic agent can pick."
          : isLaunch
          ? "REMEDIATION (preferred, no human step needed) — make the brief's FIRST line exactly the " +
              "corrected `ROLE: <role>` line the finding names and set the call's `effort` (Codex " +
              "spawn_agent: `reasoning_effort`) to the effort it names; the finding lists every valid role " +
              "and the roles a generic Explore/general-purpose launch can pick. To run at a different level, " +
              "make the SECOND line `EFFORT-OVERRIDE: <level> — <reason>` and set that effort; the override is recorded."
          : "REMEDIATION (preferred, no human step needed) — dispatch a FRESH agent with the corrected " +
              "`ROLE: <role>` line and the effort the finding names, instead of re-tasking this one; a " +
              "running agent's effort cannot be changed by a message.",
      );
      remedy.push(isWorkflow ? "fix each named agent() call's ROLE line and effort (preferred)"
        : isLaunch ? "fix the ROLE line and effort (preferred)" : "dispatch a fresh agent (preferred)");
    }
    emit({
      hookEvent: "PreToolUse",
      severity: "block",
      // EVERY finding, each on its own line under its OWN class. The response is a block because a
      // `[block]` line is present; a MUST-6 or MUST-9 line riding on the same brief keeps the class
      // it would have had alone. An earlier revision rendered only the blocking evidence here, so a
      // brief that was BOTH at a missing path AND, say, a serial lane-orchestrator brief lost the
      // second finding: the agent fixed the path, re-issued, and only then met the advisory.
      what_happened:
        `This ${tool} ${launchLike ? "dispatch" : "follow-up"} ${what.join(", and ")}, and drew ` +
        `${findings.length} dispatch-contract finding(s). The [block] line(s) stop the call; ` +
        `every other line keeps its own class and would not have blocked on its own:\n` +
        renderFindingLines(findings),
      why: why.join(" "),
      agent_must_report: [
        ...report,
        ...(nonBlocking > 0
          ? [
              "Name each NON-block finding's rule_id above and correct the brief for it as well, " +
                "or state in one line why it is right as issued — the override below lifts the " +
                "block only and answers none of them.",
            ]
          : []),
        ...(gate
          ? [
              gate.formatOverrideInstruction(digest),
              ...(effortBlocks.length > 0
                ? [
                    `The operator/CI environment channel does NOT lift an ${EFFORT_RULE_ID} block — only the ` +
                      "one-shot receipt above or the brief's recorded EFFORT-OVERRIDE line can.",
                  ]
                : []),
            ]
          : [
              `No override receipt can be offered (${unavailable}); this ${EFFORT_RULE_ID} block keeps its ` +
                "in-band remedy above.",
            ]),
      ],
      agent_must_wait:
        `Do not retry this ${launchLike ? "dispatch" : "call"} unmodified. Either ${remedy.join(" and ")}` +
        (gate
          ? `, or write the receipt line above (bound to this ${launchLike ? "dispatch" : "call"}) to ` +
            `${lib.OVERRIDE_RECEIPT_REL} and retry.`
          : "."),
      user_summary:
        [
          workdirBlocks.length > 0
            ? `agents/worktree-orchestration-absolute-path-pin — blocked a ${tool} dispatch naming a ` +
              `non-existent working directory`
            : null,
          effortBlocks.length > 0
            ? `${EFFORT_RULE_ID} — blocked a ${tool} ${launchLike ? "dispatch" : "follow-up"} ` +
              `(${[...new Set(effortBlocks.map((f) => f.code))].join(", ")})`
            : null,
        ].filter(Boolean).join("; ") +
        (nonBlocking > 0 ? ` (+${nonBlocking} non-block finding(s))` : ""),
    });
    return; // emit() exits; unreachable.
  }
}

/** Launch and re-task tool names — the registered matchers, `Task|Agent|Workflow` here and
 * `SendMessage` on `dispatch-retask-guard.js`. */
const LAUNCH_TOOLS = ["Task", "Agent"];
const RETASK_TOOLS = ["SendMessage"];
/** Duplicated from `lib/effort-routing.js::WORKFLOW_TOOL` so admission works when that lib will not load. */
const WORKFLOW_TOOL = "Workflow";
/** Duplicated from `lib/effort-routing.js::RULE_ID` so the renderer works when that lib will not load. */
const EFFORT_RULE_ID = "agents/effort-routing";

/**
 * Run the effort-routing decision for this call. Returns `{findings, override}`, or null when the
 * arm has nothing to say (a follow-up declaring no ROLE).
 *
 * FAIL-CLOSED on a LAUNCH: a library that will not load, or a decision that throws, is a BLOCK —
 * a launch this arm could not evaluate is a launch it cannot route. On a FOLLOW-UP the same failure
 * passes through IN-PROCESS: blocking every SendMessage because a library is missing would wedge
 * every lane's delivery channel, and the follow-up check is the re-tasking half, not the routing
 * gate itself. A follow-up whose guard does not FINISH at all (a crash, or an overrun of the
 * registered budget) passes too: the re-task entry, `dispatch-retask-guard.js`, is registered with
 * `on_incomplete: "continue"` (`.claude/hooks/dispatch-registry.json`), while this file's launch
 * row is `deny`. Codex differs, and the difference is not this guard's: its native-policy adapter
 * refuses a call whenever ANY selected policy fails to run, whatever that row declares
 * (`lib/codex-native-policy.js::evaluateNative`).
 */
function evaluateEffortRouting(tool, p, isLaunch) {
  let er;
  try {
    er = require(path.join(__dirname, "lib", "effort-routing.js"));
  } catch {
    if (!isLaunch) return null;
    return { findings: [unevaluableFinding("the effort-routing library could not be loaded", "effort-routing.js")], override: null };
  }
  try {
    if (isLaunch) return er.decideLaunch(p.tool_input, er.loadRoutingTable(), p);
    if (!er.declaresRole(p.tool_input)) return null;
    const launch = launchEffortOf(p, er);
    return er.decideRetask(p.tool_input, er.loadRoutingTable(), launch);
  } catch {
    if (!isLaunch) return null;
    return { findings: [unevaluableFinding("the effort-routing decision threw", "effort-routing.js")], override: null };
  }
}

/**
 * Run the effort-routing decision over a WORKFLOW call's script (finding ROOT-W1). FAIL-CLOSED like a
 * launch: a library that will not load, or a decision that throws, BLOCKS the Workflow with the
 * self-correct restore text. A script this cannot READ is judged by the decision, which fails closed
 * on it with the remedy to inline the script or pass a readable scriptPath.
 * Carries the resolved script text for the receipt digest (`digestInputOf`).
 */
function evaluateWorkflowRouting(p) {
  let er;
  let ws;
  try {
    er = require(path.join(__dirname, "lib", "effort-routing.js"));
  } catch {
    return { findings: [unevaluableFinding("the effort-routing library could not be loaded", "effort-routing.js")], override: null };
  }
  try {
    ws = require(path.join(__dirname, "lib", "workflow-launch-scan.js"));
  } catch {
    return { findings: [unevaluableFinding("the workflow-script scanner could not be loaded", "workflow-launch-scan.js")], override: null };
  }
  try {
    const resolved = ws.resolveWorkflowScript(p.tool_input);
    const scan = resolved.ok ? ws.scanWorkflowScript(resolved.text) : null;
    const r = er.decideWorkflowLaunch(resolved, scan, er.loadRoutingTable());
    return { findings: r.findings, override: null, overrides: r.overrides, summary: r.summary,
      scriptText: resolved.ok ? resolved.text : null };
  } catch {
    return { findings: [unevaluableFinding("the workflow effort-routing decision threw", "workflow-launch-scan.js")], override: null };
  }
}

/**
 * What a receipt's call digest covers. For a launch, the tool_input itself (its prompt and subagent
 * type). For a Workflow it is the RESOLVED SCRIPT TEXT — the Workflow tool_input has no `prompt`, so
 * digesting it as-is would bind a receipt to every Workflow call alike; the script is what decides
 * every agent's ROLE and effort, so a receipt lifts this script and no other.
 */
function digestInputOf(p, isWorkflow, effort) {
  if (!isWorkflow) return p.tool_input;
  const text = effort && typeof effort.scriptText === "string" ? effort.scriptText : null;
  // No resolved script (the scanner never ran): the whole tool_input, canonicalized by the digest's
  // own fallback, so the receipt still names THIS call's script, path or saved name.
  return text === null ? p.tool_input : { subagent_type: "", prompt: text };
}

/**
 * The finding id a receipt's call digest binds. For an EFFORT block on a launch it carries the effort
 * value the call requested — `agents/effort-routing@<effort>` — because `callDigestOf` covers the
 * prompt but not the `effort` parameter, so a receipt written to lift one level would otherwise lift
 * the same brief at ANY level. Every other finding binds by its rule id, unchanged.
 */
function bindingIdOf(f, p, isLaunch) {
  if (f.rule_id !== EFFORT_RULE_ID || !isLaunch) return f.rule_id;
  const ti = p && p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const e = ti.effort;
  return `${EFFORT_RULE_ID}@${typeof e === "string" ? e : e === undefined ? "absent" : JSON.stringify(e)}`;
}

/** Bounded facts a receipt-use row records when a receipt lifts an EFFORT block (string values only). */
function effortReceiptDetail(tool, p, isLaunch, effortBlocks) {
  const ti = p && p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const detail = { tool, codes: [...new Set(effortBlocks.map((f) => f.code))].join(",") };
  if (isLaunch) detail.applied = typeof ti.effort === "string" ? ti.effort : "absent";
  return detail;
}

/**
 * The refusal used when the shared renderer will not load and an EFFORT block must still stop the
 * call: the same three channels the renderer uses for a PreToolUse block (stderr body, the
 * `permissionDecision: "deny"` pair, exit 2), built by hand so the arm needs no library to fail closed.
 */
function hardDeny(tool, isLaunch, findings, note) {
  const body = [
    `STOP — Tool call blocked. This ${tool} ${isLaunch ? "dispatch" : "follow-up"} drew ${findings.length} ` +
      `dispatch-contract finding(s) (${note}); the [block] line(s) stop it:`,
    "",
    renderFindingLines(findings),
    "",
    isLaunch
      ? "SELF-CORRECT (no human step needed): make the brief's FIRST line `ROLE: <role>` and set the call's " +
        "`effort` (Codex spawn_agent: `reasoning_effort`) to the level that role maps to, or add the second line " +
        "`EFFORT-OVERRIDE: <level> — <reason>`; then re-issue. Each finding above names the corrected line, " +
        "the effort and the valid roles."
      : "SELF-CORRECT (no human step needed): dispatch a FRESH agent at the effort the new ROLE requires instead " +
        "of re-tasking this one; each finding above names the corrected line and the effort.",
  ].join("\n");
  try {
    process.stderr.write("\n" + body + "\n");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: body },
    }) + "\n");
  } catch {}
  process.exit(2);
}

function unevaluableFinding(why, libFile) {
  return {
    rule_id: EFFORT_RULE_ID,
    severity: "block",
    code: "UNEVALUABLE",
    evidence: `UNEVALUABLE: ${why}, so this launch cannot be routed — the arm fails closed. SELF-CORRECT ` +
      `(no human step needed): restore the SHIPPED library — \`git checkout HEAD -- .claude/hooks/lib/${libFile}\` ` +
      "(or re-pull it from your template) — then re-issue with the brief's FIRST line `ROLE: <role>` and that " +
      "role's effort (Claude Agent/Task: `effort`; Codex spawn_agent: `reasoning_effort`). " + rolesFromTableFile(),
  };
}

/**
 * The valid roles read straight from the shipped table with NO library — the UNEVALUABLE remedy must
 * still name them when `lib/effort-routing.js` is the thing that will not load. Best effort: a table
 * that will not read or parse yields a pointer to the file instead of a list.
 */
function rolesFromTableFile() {
  try {
    // The refusals `lib/effort-routing.js::loadRoutingTable` applies: a symlink is never followed (O_NOFOLLOW) and
    // the read is size-capped, so the remedy text cannot be steered by a planted link.
    const file = path.join(__dirname, "lib", "effort-routing-policy.json");
    let t;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 64 * 1024) throw new Error("not a bounded regular file");
      t = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
    const roles = t && t.roles && typeof t.roles === "object" && !Array.isArray(t.roles) ? t.roles : null;
    const list = roles ? Object.entries(roles).filter(([r, l]) => typeof l === "string").map(([r, l]) => `\`ROLE: ${r}\` (effort ${l})`) : [];
    if (list.length > 0) {
      return `Valid first lines (effort): ${list.join(", ")}. A generic launch (a built-in skill dispatching an ` +
        "Explore or general-purpose agent) uses `ROLE: explore-search` for read-only search or `ROLE: routine-implementation` for routine edits.";
    }
  } catch {}
  return "The valid roles and their efforts are listed in .claude/hooks/lib/effort-routing-policy.json.";
}

/**
 * The effort the follow-up's RECIPIENT was launched with, from the T1 dispatch ledger
 * (`lib/dispatch-ledger.js`). Read-only. NEVER throws: every failure is an `unknown` state, which
 * the decision turns into an ADVISORY, never a block — missing history is not evidence of a wrong
 * effort. The main checkout is resolved FAIL-CLOSED (`requireMainCheckout`), bounded by this hook's
 * own timer, exactly as the ledger's producer resolves it.
 */
function launchEffortOf(p, er) {
  try {
    const DL = require(path.join(__dirname, "lib", "dispatch-ledger.js"));
    const { requireMainCheckout } = require(path.join(__dirname, "lib", "state-resolver.js"));
    const resolved = requireMainCheckout(PROJECT_DIR, { deadline: STARTED_AT + BUDGET_MS - LEDGER_SAFETY_MS });
    if (!resolved || !resolved.ok) return { state: "unknown", reason: "the main checkout could not be confirmed" };
    const read = DL.readLedger({ repoDir: resolved.repoDir, sessionId: DL.resolveSessionId(p.session_id) });
    if (!read.ok) {
      return { state: "unknown", reason: read.absent ? "no dispatch ledger for this session" : "the dispatch ledger is unreadable" };
    }
    return er.launchEffortFor(read.rows, er.recipientOf(p.tool_input), DL.generationOf(p));
  } catch {
    return { state: "unknown", reason: "the dispatch-ledger lookup failed" };
  }
}

/**
 * RECORD an honoured EFFORT-OVERRIDE in the shared override use ledger, BEFORE it is honoured.
 * Honoured ⇔ recorded, exactly as for a receipt: a row that cannot be written turns the honour into
 * a BLOCK naming why, so an override can never pass and leave no trace — the incident class this
 * guard's override channel exists to close (header § THE OVERRIDE).
 */
function recordEffortOverride(effort, tool, p, overrideLib) {
  const o = effort.override;
  let rec;
  if (!overrideLib) {
    rec = { ok: false, error: "the override library could not be loaded" };
  } else {
    try {
      rec = overrideLib.recordInlineOverride({
        invokingRoot: PROJECT_DIR,
        channel: `${EFFORT_RULE_ID}/EFFORT-OVERRIDE`,
        digest: overrideLib.callDigestOf(tool, p.tool_input, [bindingIdOf({ rule_id: EFFORT_RULE_ID }, p, true)]),
        reason: o.reason,
        consumer: overrideLib.consumerOf(p),
        // A `fork` runs at its parent's effort, so what APPLIED is the parent's level, not the one
        // the override line declares; both are recorded, never conflated.
        detail: o.fork
          ? { tool, role: o.role, required: o.required, applied: "parent (fork)", declared: o.level }
          : { tool, role: o.role, required: o.required, applied: o.level },
      });
    } catch {
      rec = { ok: false, error: "the recorder threw" };
    }
  }
  if (rec && rec.ok) return effort.findings;
  const safe = (v) => (overrideLib ? overrideLib.safeField(v, "unknown", 80) : String(v).slice(0, 80));
  return [
    {
      rule_id: EFFORT_RULE_ID,
      severity: "block",
      code: "OVERRIDE_UNRECORDED",
      evidence:
        `OVERRIDE_UNRECORDED: the EFFORT-OVERRIDE (${o.level} for role \`${o.role}\`, which requires ` +
        `${o.required}) could not be recorded in the override use ledger ` +
        `(${safe(String((rec && rec.error) || "unknown"))}), so it is NOT ` +
        `honoured. SELF-CORRECT (no human step needed): make the brief's FIRST line exactly \`ROLE: ${o.role}\` and pass ` +
        `effort ${o.required} — dropping the EFFORT-OVERRIDE line — or retry the override once the ledger is writable.`,
    },
  ];
}

/**
 * Render EVERY non-block finding in ONE response through the shared renderer
 * (`lib/instruct-and-wait.js::emit`), so two predicates firing on one brief — MUST-6 and
 * wip-discipline MUST-9 on a named lane-orchestrator brief, say — reach the orchestrator as one
 * report, never as two.
 *
 * `severity: "pre-action"` is the RENDER register, not a re-grading of any finding: each finding
 * keeps its own class on its `[severity]` line. It is the only head that is TRUE at PreToolUse —
 * `halt-and-report` renders "the action ALREADY RAN" and `advisory` renders "the action
 * proceeded", and the dispatch has done neither (`instruct-and-wait.js` § loom#1715 H-1; the same
 * correction `wip-discipline-guard.js` records for its own pending-dispatch report).
 *
 * NO OVERRIDE RECEIPT IS CONSUMED OR OFFERED on this path, at either class. The call is not
 * stopped, so there is nothing to lift; and a receipt written "to record why" would not be consumed
 * by THIS call, so it would sit until it silently lifted the NEXT, unrelated block under a reason
 * written for something else. The record for this tier is the one-line reason the report requires.
 */
function emitNonBlocking(tool, findings, isLaunch) {
  // A renderer that will not load degrades this NON-blocking tier to the plain report rather than
  // drop the findings — decided outside the catch, as on the block path. Nothing here is a block.
  let emit = null;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    emit = null;
  }
  if (typeof emit !== "function") return passthrough(renderFallback(findings, "renderer unavailable"));
  const ruleIds = [...new Set(findings.map((f) => f.rule_id))];
  const contractFindings = findings.filter((f) => f.rule_id !== EFFORT_RULE_ID);
  const effortFindings = findings.filter((f) => f.rule_id === EFFORT_RULE_ID);
  const why = [];
  if (contractFindings.length > 0) {
    why.push(
      "No dispatch-contract finding on this tier carries teeth — this hook cannot stop the call. For " +
        "the prose-reading predicates that is a CAP: hook-output-discipline.md MUST-2 forbids `block` " +
        "on a lexical signal. For `agents/agent-definition-shadowing` it is a deliberate CHOICE, not a " +
        "cap — its evidence is two files on disk and would permit teeth, which are declined because the " +
        "repo defect it reports is not one this dispatch introduced. " +
        "`agents/worktree-orchestration-absolute-path-pin` arrives here only as an advisory, when every " +
        "lane root the brief names is an unfilled placeholder: nothing on disk was measured, so it is " +
        "capped like the prose predicates.",
    );
  }
  if (effortFindings.length > 0) {
    why.push(
      `The ${EFFORT_RULE_ID} line(s) are not blocks either. OVERRIDE_HONOURED records that this call ` +
        "runs at a level other than its ROLE's under the brief's EFFORT-OVERRIDE line — honoured because " +
        "that override is recorded in the override use ledger. On a follow-up, a finding whose recipient's " +
        "launch effort is UNKNOWN (no recorded launch, a launch with no recorded effort, or launches that " +
        "disagree) is advisory, because a re-task can be judged only against a known launch.",
    );
  }
  why.push(
    "All findings are rendered in this one response, so predicates firing on the same call never " +
      "double-fire. No override receipt applies here: nothing is blocked, so there is nothing to lift.",
  );
  const noun = isLaunch === false ? "follow-up" : "dispatch";
  emit({
    hookEvent: "PreToolUse",
    severity: "pre-action",
    what_happened:
      `This ${tool} ${noun} has NOT been issued yet and drew ${findings.length} ` +
      `dispatch-contract finding(s):\n` +
      renderFindingLines(findings),
    why: why.join(" "),
    agent_must_report: [
      "Name each finding's rule_id, then either correct the call before issuing it or state in " +
        "one line, in your next message, why it is right as issued — that stated line is the " +
        "record for this tier.",
    ],
    agent_must_wait:
      `Correct the ${noun} and re-issue it, or proceed with your stated reason — this is not a block.`,
    user_summary: `dispatch-contract — ${ruleIds.join(", ")} on a ${tool} ${noun} (not blocked)`,
  });
}

/**
 * Plain rendering for the degraded paths (no renderer, or no override channel). Keeps every finding
 * visible, each under its own class, without offering an escape that would not work.
 */
function renderFallback(findings, note) {
  return [
    `⚠ Dispatch-contract findings — NOT blocked (${note}).`,
    "",
    renderFindingLines(findings),
  ].join("\n");
}

/** Reset the per-run state — the in-process engine requires this module once per worker. */
function beginRun() {
  STARTED_AT = Date.now();
  launchTool = null;
}

/** The LAUNCH entry's run body: `Task|Agent|Workflow`, judged under the launch scope. */
async function launchMain(payload) {
  beginRun();
  return evaluate("launch", payload);
}

/**
 * The RE-TASK entry's evaluation (`dispatch-retask-guard.js`, SendMessage). It owns its own reader and
 * its own fail-open run boundary, because its row is `on_incomplete: continue`; this module only judges.
 */
function evaluateRetask(payload) {
  beginRun();
  return evaluate("retask", payload);
}

// hookMain — this file's entry (the LAUNCH scope), run by the CLI guard at the bottom of this file
// AND in-process by lib/hook-engine.js (dispatch.js). THE LAUNCH SCOPE FAILS CLOSED ON AN INCOMPLETE
// CHECK (E3 R2): its row is `on_incomplete: deny`, and a `{continue:true}` from an unfinished run would
// be a parseable ALLOW. guard-runner.js::runGuard reads the payload (refusing an empty, stalled,
// unparseable or oversized stdin) and refuses a throw or a standalone run past BUDGET_MS.
//
// THE RECOVERY LINE IS DECLARED HERE, STATICALLY (runGuard's `refusal` option): the remedy this
// guard's own incomplete-check refusal always carried (owner ruling on correctness #4: a block the
// agent can correct itself, never one that needs a human) — relaunch unchanged; if refused again,
// restore the shipped hooks; relaunch with a valid ROLE line and its effort. It rides every refusal
// the runner builds for this guard; the valid roles are named by the table file, not listed here,
// so no copy of the table can drift from it.
const LAUNCH_RECOVERY =
  "SELF-CORRECT (no human step needed): relaunch it unchanged. If the same refusal returns, restore the SHIPPED " +
  "hooks — `git checkout HEAD -- .claude/hooks/` (or re-pull them from your template) — and relaunch with the " +
  "brief's FIRST line `ROLE: <role>` and that role's effort (Claude Agent/Task: `effort`; Codex spawn_agent: " +
  "`reasoning_effort`). The valid roles and their efforts are listed in .claude/hooks/lib/effort-routing-policy.json.";
const LAUNCH_REFUSAL = Object.freeze({ recovery: LAUNCH_RECOVERY });
const hookMain = runGuard("dispatch-contract-guard", launchMain, { budgetMs: BUDGET_MS, refusal: LAUNCH_REFUSAL });

module.exports = { hookMain, evaluateRetask, passthrough, BUDGET_MS };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
