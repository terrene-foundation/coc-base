---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/hooks/**"
  - "**/.claude/variants/**/hooks/**"
  - "**/.claude/audit-fixtures/{violation-patterns,hook-output-discipline,variant-hook-output-discipline}/**"
  - "**/.claude/test-harness/probes/hook-output-discipline.probes.json"
  - "**/.claude/test-harness/tests/refusal-delivery-channel.test.mjs"
---

# Hook Output Discipline — No Raw exit(2)

<!-- slot:neutral-body -->

Hooks are the structural enforcement layer of the trust-posture system. A block refuses ONE call — exit code `2` plus `permissionDecision: "deny"` and its reason — and hands that reason to the agent to resolve; the agent receives ONLY what the hook emits. It does NOT end the agent's turn: `lib/instruct-and-wait.js` no longer emits `continue: false` on a block (operator directive 2026-09-25, `8e0f74c64`), because that field stopped the whole session and left an already-answered refusal waiting on a human. A hand-rolled `continue: false` would still halt at the NON-STOP_LIKE events, which is why MUST-1 below still names it. **At `Stop` / `SessionEnd` / `PreCompact` that sentence is FALSE and the scoping is load-bearing:** `continue: false` was MEASURED INERT at `Stop` (2026-08-20, isolated `claude -p` probe, three arms on one tree) — its output was byte-indistinguishable from a control emitting no fields at all, and the hook did not re-fire. The mechanism that returns control to the model there is `decision: "block"` + `reason`, which MUST-6 governs. An unscoped reading of this sentence is what sends an author reaching for `continue: false` at a Stop hook and measuring nothing. A raw `process.exit(2)` with no payload tells the user "Execution stopped by PostToolUse hook" with no actionable content, and tells the agent nothing — institutional knowledge of WHY the block fired is lost the moment continuation halts.

This rule binds every hook in `.claude/hooks/**` to the canonical `instruct-and-wait.js::emit()` shape. It also forbids the false-positive class that ships `severity: "block"` from a lexical regex match alone — block severity requires a structural / behavioral / AST signal that the regex cannot evade by surface rewrite.

Pairs with `cc-artifacts.md` Rule 7 (timeout fallback), `trust-posture.md` § "Two-Phase Rollout" (block teeth at L2/L3), and `instruct-and-wait.js` library (the canonical shape this rule mandates).

## MUST Rules

### 1. Every Halting Hook MUST Emit The Full instructAndWait Shape

Any hook that returns `continue: false` (PostToolUse / UserPromptSubmit / SessionStart) OR exits with code `2` (PreToolUse only) MUST construct its output via `lib/instruct-and-wait.js::emit()` with all six fields populated: `severity`, `what_happened`, `why`, `agent_must_report` (≥1 entry), `agent_must_wait`, `user_summary`. Raw `process.exit(2)` and bare `process.stdout.write(JSON.stringify({continue: false}))` are BLOCKED.

**Compact render (journal/0661).** The six fields are the RECORD, not the context payload. When a session resolves, every NON-DENY finding renders in context as ONE line — rule id, fate, `user_summary` (≤160 chars), a pointer to the full body in `.claude/learning/hook-findings/<session>.md` — and an unchanged repeat within the session renders a one-line stub (non-Stop) or nothing (non-refusing Stop). A deny (block at a non-STOP_LIKE event) keeps the full body; no block, deny or refusal decision depends on the render. Hand-rolling a long-form payload to bypass the compact render is BLOCKED.

```javascript
// DO — emit() populates the canonical shape, agent gets actionable report
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
emit({
  hookEvent: "PostToolUse",
  severity: "halt-and-report",
  what_happened: `Bash command flagged: ${cmd.slice(0, 80)}`,
  why: "repo-scope-discipline/MUST-NOT-1",
  agent_must_report: [
    "Quote the exact command that triggered the detection",
    "State which rule was violated and its origin date",
    "Propose remediation in this turn (do not file a follow-up issue)",
  ],
  agent_must_wait: "Do not retry until the user instructs.",
  user_summary: `repo-scope-discipline/MUST-NOT-1 — ${cmd.slice(0, 60)}`,
});

// DO NOT — raw exit, no payload, agent sees only "Execution stopped"
if (offRepo) {
  process.stdout.write(JSON.stringify({ continue: false }) + "\n");
  process.exit(2);
}
```

**BLOCKED rationalizations:**

- "The user_summary on stderr is enough; the agent doesn't need agent_must_report"
- "Raw exit is faster; the canonical shape is overhead"
- "The hook name is in the error message, that's the why"
- "Populating six fields for a one-line detector is bureaucracy"
- "Future maintainers will know what the hook does from the file name"
- "We'll add the canonical shape later if anyone complains"
- "Exit 2 is the documented mechanism; that IS the contract"
- "The next session can grep the hook source to find what fired"

**Why:** When `continue: false` (or PreToolUse exit 2) fires, the agent's next message receives the hook's output as authoritative context. If that output is empty, the agent has no idea WHY it halted, what to report, or what action the user expects — it either guesses wrong, files a follow-up issue (violating `autonomous-execution.md` MUST Rule 4), or asks the user to re-explain the rule the hook just enforced. The CC UI shows the user "Execution stopped by PostToolUse hook" — useless without the `user_summary` stderr line. The instructAndWait shape converts a silent flow-stop into a structured handoff: user sees the violation summary, agent sees the report-and-wait protocol, both can act. Origin: 2026-05-06 — `detectRepoScopeDriftBash` shipped `severity: "block"` and was wired through `logAndEmit` (which DID populate the shape), but a parallel review surfaced that NO rule mandated the shape, so future detectors authored without `logAndEmit` would silently regress to raw exit — institutional drift waiting to happen.

### 2. severity:block MUST NOT Come From Lexical Regex Alone

A finding with `severity: "block"` MUST be grounded in a structural / behavioral / AST / process-state signal that surface rewrites cannot evade. Lexical regex matches against shell command strings, file contents, or agent prose MUST emit `severity: "halt-and-report"` or `severity: "advisory"`, never `block`. Block severity is for structural facts the agent cannot rationalize away (e.g., `CLAUDE_WORKTREE_PATH` env set + absolute path outside it; pre-commit exit code non-zero; `git status --porcelain` non-empty before `--hard`).

**NAMED EXCEPTION — a DISCLOSURE-ISOLATION boundary MAY block on a content scan.** A guard enforcing a
disclosure-isolation invariant across an ecosystem boundary (today: the FORK→CANON direction of the
canon↔fork fence — the canon→fork INTAKE direction is NOT admitted, because on intake the write target is
the fork's own tree and condition (a)'s declared-cross-ecosystem-target predicate does not hold)
MAY carry `block` on a content-scan finding. The exception is NARROW and ALL FOUR conditions are
load-bearing; **(a) is the structural one and the other three do not stand without it**:

- **(a) STRUCTURAL PRECONDITION.** The block branch is reachable ONLY after a structural boundary
  predicate holds — a DECLARED cross-ecosystem write target matched against a configured upstream-canon
  pointer — so the scan REFINES an already-structural gate and can never fire on ordinary in-repo work.
  An always-on content scan does NOT qualify, however confidential its subject.
- **(b) CONFIDENTIALITY across a TENANCY boundary**, not code quality. A tenant COUPLING judgment is not
  a content scan and does NOT inherit this grant.
- **(c) IRREVERSIBLE failure** — a leak reaching a multi-tenant-shared surface is correlatable across
  every other tenant and cannot be recalled.
- **(d) FAILS CLOSED WHENEVER A SCAN IS REQUIRED** — an unverified scan refuses. A carve-out establishing
  neutrality by AUTHORITY rather than by scan is permitted ONLY if it is allowlist-gated and ANY finding
  overrides it; (d) is not a claim that the guard never allows an unscanned write.

A guard invoking this exception MUST say so at the block site and MUST NOT describe its signal as
structural when it is not.

**Why this does not weaken MUST-2 — argued from MUST-2's OWN stated harm, not a re-characterisation of
it:** MUST-2's `**Why:**` names exactly ONE harm, and it is a false positive: a regex matches a surface
form, the hook emits `block`, and "agent got hard-blocked from in-scope work". Condition (a) makes that
harm STRUCTURALLY UNREACHABLE here — absent a declared cross-ecosystem target the guard passes through, so
a false positive cannot touch in-scope work at all; it can only refuse a write the session itself declared
as crossing to canon. The exception is bounded by the very property MUST-2 protects rather than traded
against it. **It is NOT argued on cost-symmetry or on false negatives** — MUST-2 weighs neither, and an
earlier revision of this clause asserted both, and additionally offered "the agent rationalises past a
fence" as MUST-2's motivation when MUST-2 lists "halt-and-report lets the agent rationalize and proceed"
in its OWN BLOCKED-rationalization corpus. That reasoning was retracted; this is its replacement.

```javascript
// DO — the exception NAMED at the block site, with the structural precondition cited
//      (cross-ecosystem-disclosure-guard.js: the real shape)
if (!targetEcosystem) passthrough();          // (a) structural gate: no declared
                                              //     cross-ecosystem target ⇒ never reached
const result = await guardForkToCanonWrite(guardOpts);
if (result.ok) passthrough();
// BLOCK — under the DISCLOSURE-ISOLATION exception in hook-output-discipline.md MUST-2,
// NOT as a structural signal: the boundary is structural but does not block on its own;
// the content scan is the discriminator. (a) holds at :172, (d) at lib:569-575.
emit({ severity: "block", ... });

// DO NOT — claim the signal is structural because the BOUNDARY is
// (the retracted comment this exception exists to replace)
// BLOCK — structural boundary primitive (hook-output-discipline.md MUST-2).
emit({ severity: "block", ... });

// DO NOT — invoke the exception from a guard with no structural precondition:
// an always-on content scan over every Write/Edit body fails (a), however
// confidential its subject, and is the class MUST-2 exists to bar.
if (/customer-name/.test(fileBody)) emit({ severity: "block", ... });
```

**BLOCKED rationalizations (the EXCEPTION's own — these guard its expansion, not MUST-2's general rule):**

- "This is basically a disclosure boundary too"
- "Confidentiality is at stake here as well, so the exception applies"
- "My signal is a content scan but the boundary around it is structural"
- "The data is irreversible once leaked, which is conditions (b) and (c) — close enough"
- "I fail closed, so I satisfy the spirit of it"
- "Scoping it behind a declared target would make the guard too narrow to be useful"

```javascript
// DO — block grounded in structural signal (env var + path prefix)
function detectWorktreeDrift(filePath) {
  const pinned = process.env.CLAUDE_WORKTREE_PATH;
  if (!pinned) return null; // structural gate: only fires inside a worktree
  if (filePath.startsWith("/") && !filePath.startsWith(pinned)) {
    return {
      rule_id: "worktree-isolation/MUST-1",
      severity: "block",
      evidence: `...`,
    };
  }
  return null;
}

// DO — lexical regex emits halt-and-report (agent must surface and acknowledge, not blocked)
function detectRepoScopeDriftBash(command, cwd) {
  const m = command.match(/\bgh\b[^|;]*--repo\s+([^\s]+)/);
  if (!m) return null;
  const targetRepo = m[1];
  if (/\$\{?\w+/.test(targetRepo)) return null; // skip shell-variable references
  const cwdBase = path.basename(cwd || process.cwd());
  if (!targetRepo.includes(cwdBase)) {
    return {
      rule_id: "repo-scope-discipline/MUST-NOT-1",
      severity: "halt-and-report",
      evidence: `...`,
    };
  }
  return null;
}

// DO NOT — block from lexical regex; surface rewrite (`gh ... --repo $REPO`) flips false positive into hard block
function detectRepoScopeDriftBash(command, cwd) {
  const m = command.match(/\bgh\b[^|;]*--repo\s+([^\s]+)/);
  if (m && !m[1].includes(path.basename(cwd))) {
    return {
      rule_id: "repo-scope-discipline/MUST-NOT-1",
      severity: "block",
      evidence: `...`,
    };
  }
}
```

**Pairs with** `rules/probe-driven-verification.md` MUST-4: lexical hook detectors MAY use regex BUT MUST be paired with a probe-driven gate-review counterpart at `/codify` validation. Hooks alone cannot resolve semantic claims; probes are the authoritative verdict.

**BLOCKED rationalizations:**

- "The regex is tight, false positives are rare"
- "Block is the appropriate teeth for repo-scope discipline"
- "halt-and-report lets the agent rationalize and proceed"
- "We'll add structural validation in v2"
- "The detector caught the issue once; that proves it works"
- "Lexical match plus posture-gate is structural enough"
- "If the regex false-positives, we tighten the regex"

**Why:** Lexical regex matching against shell command strings cannot see shell expansion (`$REPO`, `${REPO}`, `$(gh repo view ...)`), command substitution, here-strings, pipes, or eval. Every false-positive class encountered by the trust-posture POC (heredoc commit-message bodies, segment-anchor mismatches, `$REPO` literal) was the same shape: agent ran a structurally-correct command, regex matched the surface form, hook emitted `block`, agent got hard-blocked from in-scope work. The structural defense is severity discipline: lexical signals are advisory or halt-and-report (agent surfaces, user adjudicates); block reserved for facts the regex cannot misread (env vars, exit codes, file existence, AST shape). This rule paired with `trust-posture.md` MUST NOT clause "Self-confess + log + downgrade in one shot from a lexical regex match alone" closes the design-time loophole that trust-posture closed at the state-write boundary. Origin: 2026-05-06 — `detectRepoScopeDriftBash` flagged `gh issue list --repo "$REPO"` as off-repo because the regex captured the literal string `"$REPO"` pre-expansion; agent was blocked from sweep work that was fully in-scope per `repo-scope-discipline.md`.

### 3. Command-String Detectors MUST Skip Shell-Variable References

Any detector inspecting shell command strings (`payload.tool_input.command` from PreToolUse/PostToolUse Bash) MUST skip captured groups that reference unexpanded shell variables: `$VAR`, `${VAR}`, `$(...)`, `` `...` ``. The skip is a structural NULL — return `null` before evaluating the captured value, do NOT downgrade to advisory or attempt to expand.

Depth: `.claude/guides/rule-extracts/hook-output-discipline.md` § MUST-3.

```text
# DO — skip shell variables.
# DO NOT — compare "$REPO" literally.
```

**BLOCKED rationalizations:**

- "Most users don't use shell variables in `gh` commands"
- "We can `child_process.execSync` to expand the variable"
- "The regex is fine; users should inline the value"
- "$REPO is rare; the detector catches the common case"
- "Hook is post-tool, the variable IS expanded by then" (FALSE — `payload.tool_input.command` is the pre-expansion string CC sent to bash)

**Why:** `payload.tool_input.command` is the literal bash string CC passed to the shell — it is the pre-expansion form. Shell variables, command substitution, here-strings, and pipes are all evaluated by bash, not by the hook. Treating `"$REPO"` as a static string and checking substring membership is a category error: the detector is asking "does this 6-character literal contain my repo name?" when the actual question is "what would this evaluate to at runtime?" — which the hook cannot answer without re-running the shell, which is its own security/correctness disaster. The skip is the only correct disposition: when the captured group is shell-variable-shaped, the detector has insufficient information and MUST emit nothing. Origin: 2026-05-06 — same incident as Rule 2.

### 4. Detectors MUST Ship With Committed Audit Fixtures

Every detector function in `.claude/hooks/lib/violation-patterns.js` MUST ship with at least one committed fixture per scope-restriction predicate it relies on, under `.claude/audit-fixtures/violation-patterns/<detector>/`. Fixtures cover: (a) clean input that MUST NOT flag, (b) flagging input that MUST flag, (c) for command-string detectors, at least one shell-variable input that MUST NOT flag (Rule 3 enforcement). Per `cc-artifacts.md` Rule 9 — fixtures are mechanical regression locks for scope-restriction predicates.

```text
# DO — commit clean, flagging, and shell-variable cases.
# DO NOT — cover only the happy path.
```

Layout example: companion extract § MUST-4.

**BLOCKED rationalizations:**

- "The detector is too simple to need fixtures"
- "The trust-posture-poc tests cover the detector indirectly"
- "Fixture maintenance overhead exceeds the regression risk"
- "We'll add the shell-variable fixture when the bug recurs"

**Why:** The detectRepoScopeDriftBash false positive shipped because no fixture forced the scope-restriction predicate (literal-vs-variable distinction) into the test surface. `cc-artifacts.md` Rule 9 generalizes the principle for all audit tools; this rule applies it specifically to violation-patterns where the regression cost is measured in user-blocked sessions, not advisory false-positives. Origin: 2026-05-06 — same incident as Rules 2 and 3.

### 5. A Detector Meant To ENFORCE Dispatches On A Parsed Signal; A Lexical-Only One Is Declared PERMANENTLY Advisory

MUST-2 governs what a lexical signal may not CARRY. This is its other half — what the author owes BEFORE the severity question is reachable.

**(a) Signal selection.** A detector authored or planned to FENCE (to carry `block`) MUST dispatch on a signal a surface rewrite cannot evade: an argv token POSITION from a real parse, an AST node, a parsed-document field (frontmatter value, Dockerfile instruction, manifest key), a filesystem or git-object fact, or a process/tool-event read. Naming a regex over a joined command string, a file's raw text, or agent prose as the mechanism for an ENFORCING detector is BLOCKED — MUST-2 caps that signal at advisory, so it ships as noise no matter what the author intended.

**(b) Honest declaration.** When the property is observable ONLY lexically, the rule MUST declare its detection **permanently advisory** and name the semantic half as not mechanizable. Filing it instead as `Phase 2 (deferred)` enforcement is BLOCKED: the deferral books a debt that cannot be paid, and every later reader reads a permanent advisory as a scheduled fence. `hook-event-selection.md`'s "Phase 2 is NOT deferred-pending-a-detector — no structural predicate for the semantic half is believed to exist" is the canonical form.

**The discriminator is the PROPOSITION, not the technique.** String matching is not the defect. A check asserting that a LITERAL token is absent from an enumerated file set is exact and structural however it is spelled. A check inferring intent, adequacy, or completeness from prose is not, however carefully its regex is written. Ask what the check ASSERTS, then ask whether a rewrite preserving the meaning changes the answer.

Depth: `.claude/guides/rule-extracts/hook-output-discipline.md` § MUST-5.

```text
# DO — parse the subcommand.
# DO NOT — block on joined-string regex.
```

**BLOCKED rationalizations:**

- "Phase 2 will add the structural signal later" (stated where no structural signal has been named)
- "The regex is the detector; blocking is just a severity setting we flip later"
- "It is deferred, not absent — the Wiring records it"
- "A lexical detector is better than nothing"
- "We will tighten the regex until the false positives stop"
- "Declaring it permanently advisory reads like giving up"
- "The gate-review layer catches it, so the detector does not have to"
- "Parsing is over-engineering for a five-line check"

**Scope note — a blocking hook is not a merge gate.** Hooks gate TOOL CALLS; whether a change can MERGE is branch protection, a DIFFERENT surface this clause does not reach. That separation is the durable point and does not depend on any measurement. The protection STATE is mutable repo config, so **re-measure it rather than citing this line** — with `has()`, since the object-construction form yields `null` for a missing key and cannot distinguish ABSENT from PRESENT-AND-NULL. `gh api repos/:owner/:repo/branches/main/protection --jq '{has_required_status_checks: has("required_status_checks"), contexts: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled}'` — canon loom measured 2026-08-06 as no `required_status_checks` and `enforce_admins: false`, then **re-measured 2026-08-14 as `contexts: ["Required checks"]`, `enforce_admins: true`**; the earlier "that surface is currently empty" reading became false on 2026-08-08 and sat stale until re-measured. So a correctly-parsed blocking detector still stops only the agent's own tool call — but do NOT infer from that that nothing gates the merge, and do not infer the converse either: protection is per-repository, and a consumer's own remote may differ from canon's. This clause makes enforcement POSSIBLE at the hook layer; it says nothing about merge-gating in either direction, and MUST NOT be cited as if it did.

**Why:** A regex over a joined command string cannot see the grammar it reasons about, and its errors do not average out — they land on both sides at once. Measured on this corpus against a 13-case control (arms: main's five `L3_BLOCKED_BASH` regexes verbatim; those regexes plus the joined-string non-mutating exemption an author reaches for after the first false positives; the parsed fence): the pure-lexical arm disagreed with ground truth 7 times, the "repaired" lexical arm 5, the parsed arm 0. The repair is the instructive result — it cut false positives by converting them into DANGEROUS misses, because the exemption scan and the trigger read the same undifferentiated string. "Tighten the regex" is therefore not a path to a fence: each tightening buys a false positive back with a miss. The second cost is bookkeeping — a Phase-2 deferral filed against a property no structural predicate can observe never converges, and accumulates as pending enforcement that reads like a roadmap and functions as an unaudited permanent advisory. Reference implementation: `.claude/hooks/lib/git-command-parse.js` + the `posture-gate.js` mutation fence with its fail-closed `isNonMutating`, landing via **loom#1589** — deliberately cited by PR rather than by commit, because that branch's head moved twice under review and a pinned SHA would send the next reader to a superseded tree; once it merges, `main` IS the reference. At authoring time `main` carried `git-command-parse.js` in its pre-fence form only, without the gh arm or the fence dispatch (verified: `main` has zero `severity: "block"` returns in `posture-gate.js` and none of the four `gh` parser functions). Full case table + the two traps: the lane report cited at § Origin (MUST-5).

### 6. Refusing The `Stop` Hand-Back Is OPT-IN, BOUNDED, And NEVER Inferred From `severity`

A `Stop` hook MAY refuse the hand-back by emitting top-level `{"decision":"block","reason":<body>}`, which returns control to the model with `reason` delivered AS INSTRUCTION. Three constraints, all MUST:

**(a) Opt-in, never inferred.** Refusal MUST be requested EXPLICITLY through the emit library's refusal parameter. Inferring it from `severity` is BLOCKED: `severity: "block"` at a STOP_LIKE event records the finding's CLASS and stays NON-refusing — `burndown-integrity.md` and `fleet-drain.js` both depend on that, the latter naming "the severity cannot block" as one of three things bounding a known false-positive class.

**(b) Bounded, or not made at all.** A refusal MUST carry a per-session budget STRICTLY BELOW the host's 8-consecutive-block override, and the library — not the caller — MUST read `stop_hook_active` from the RAW payload. A caller-derived flag is BLOCKED. Bounding MUST fail OPEN: a refusal that cannot be counted is not made, because an uncountable refusal is a wedge.

**(c) `continue: false` is NOT the mechanism.** It was MEASURED INERT at `Stop` and MUST NOT be used to hold a session open.

```text
# DO — explicit, bounded, library reads the raw payload
emit({..., refuseHandback: true, payload})   → {"decision":"block","reason":<body>}  (first fire)
                                             → {"continue":true,"systemMessage":…}   (stop_hook_active)
# DO NOT — infer from severity, hand-roll the flag, or reach for continue:false
if (severity === "block") refuse()      ·      {"continue":false,"reason":…}
```

**BLOCKED rationalizations:** "severity block obviously means refuse" / "the caller already knows whether it refused" / "`continue:false` halts, so it must hold the turn open" / "the host caps it at 8, so a budget is redundant" (8 forced turns is a ruined session) / "if the counter is unreadable, refuse anyway to be safe" (that is the wedge).

**Why:** A hook that can refuse but cannot STOP refusing consumes a human's session; and a refusal inferred from severity silently converts guards whose own rule text insists their severity is not teeth.

### 7. A Halting Hook's Payload MUST Name The CHANNEL The Report Travels On — Correctly For BOTH Readers

MUST-1 fixes WHAT a halting hook reports. This fixes HOW that report reaches anyone. Every rendered payload carrying `agent_must_report` MUST also carry the delivery instruction — and it MUST be true for BOTH readers of the one renderer: a **SUBAGENT**, whose "user" is its **ORCHESTRATOR**, reachable only by a `SendMessage` tool call; and the **TOP-LEVEL session**, whose user is the human reading the terminal, for whom the reply message is the channel and a `SendMessage` would be addressed to nobody. Write it as a self-classifying pair — the agent always knows whether another agent launched it — so exactly one branch applies and both are literally true. A bare "report to user" is BLOCKED: it is unactionable for the subagent, who cannot deliver by writing.

**Routing — the AGENT resolves, the human gets only escalations (journal/0661).** A finding the agent can clear is delivered TO THE AGENT as work: at `Stop` through the bounded MUST-6 refusal where the hook has opted in, otherwise QUEUED and delivered at the next `UserPromptSubmit` (`lib/hook-findings.js::drainForAgent`) — a Stop `systemMessage` reaches only the human and never the model, so routing an agent-clearable finding there is BLOCKED. Only an `escalate` class (`security`, `disclosure`, `cross-repo`, `owner-only`, `destructive`, `structural-gate`) also reaches the human, as ONE line. The compact channel line (`COMPACT_AGENT_CHANNEL` / `compactEscalateChannel`) is the short form of the obligation below; findings about lanes/worktrees this session never touched render as ONE count line (`lib/session-ownership.js`).

The obligation is discharged by `instruct-and-wait.js::DELIVERY_INSTRUCTION`, rendered by the ONE shared renderer MUST-1 already routes every halting hook through. Hand-writing a per-hook variant is BLOCKED (`security.md` § Enforcement-Surface Parity — one shared function, never N copies that drift), as is emitting a report with no channel.

```javascript
// DO — compose the shared constant; every halting hook inherits it for free
const { emit } = require("./lib/instruct-and-wait.js");
emit({
  severity: "block",
  agent_must_report: ["Quote the refused command"] /* ... */,
});

// DO NOT — hand-roll a payload whose report names no channel, or one that names
// only SendMessage (false at top level) or only "your user" (unactionable for a subagent)
process.stdout.write(
  JSON.stringify({
    continue: false,
    hookSpecificOutput: {
      permissionDecisionReason: "BLOCKED. Report this to the user.",
    },
  }),
);
```

**BLOCKED rationalizations:**

- "The agent knows to report; naming the channel is hand-holding"
- "'Report to user' already covers it — the orchestrator IS the user"
- "A subagent's transcript is visible to the orchestrator anyway"
- "The agent will surface it when it returns" (on a refusal it may never return)
- "Adding the channel makes the payload longer"
- "This is an orchestration concern, not a hook concern"
- "The orchestrator can sweep `git status` if it wants to know"
- "One instruction cannot serve two audiences, so pick the common case"

**Why:** A refusal that is not delivered is indistinguishable from success. Measured three times in one session (2026-08-16), identical shape each time: a guard correctly refused a lane's tool call, the lane therefore emitted no payload, and the lane went idle with no summary — recovered only because the orchestrator swept `git status --porcelain` across every worktree on a hunch, finding 7 uncommitted files, then 286 insertions, then a coherent reader+writer pair, none of which has a reflog. Nothing structural caught any of them. The guards were right every time; the entire loss sat in the reporting step, because the payload's instruction was "report to user" and a subagent's user is not a human and is not reachable by writing prose. This is the same reachability class as `agents.md` § Worktree Orchestration, whose Origin (`skills/32-trust-posture/wiring/agents.md`) records a guard refusing correctly four times while "the orchestrator had no loaded instruction telling it what to do instead."

## Accepted Residual — A Hook's Own Dedupe State Is UNAUTHENTICATED (OPEN, not deferred)

Containment is not authentication. A hook that suppresses its own repeat output — "have I already said this?" — stores that decision in-tree at a path that is a **pure function of `session_id`**, over a signature space small enough to ENUMERATE: `delegation-default`'s `ADVISE:<n>:<n>` and `fleet-drain`'s `SESSION-VOLUME:<n>:<n>` are each a two-small-integer product. Anyone who can write the repo can therefore pre-plant a marker the hook reads as its own, and the hook goes silent.

The compact-render state (`lib/hook-findings.js` seen/queue rows, `lib/session-ownership.js` cursor) is the same class, and OPEN exactly as the markers above are: a planted row can turn a non-Stop finding into a one-line stub, a NON-refusing Stop finding into SILENCE (not queued), inject a ≤600-char line into the agent's next prompt (a planted queue row), and turn an owned tree into a count line — which also drops worktree-conservation's hand-back refusal for it. No row can touch a DENY.

**What IS closed — the READ.** The marker read refuses a symlink, opens `O_NOFOLLOW`, compares the fd's `dev`/`ino`, refuses on a containment failure, and refuses a non-regular file. It fails OPEN on every one of those refusals, so a REFUSED read costs one duplicated advisory and never a swallowed finding, while the ledger read next to it fails CLOSED — opposite directions of one contract, each pinned by its own pole so neither is satisfiable by "always emit" or "never report absent".

**What is NOT closed — the WRITE.** An attacker who simply writes the predictable path in the predictable format is untouched by ANY of the above: the file is in-tree, a regular file, not a symlink, and well-formed. MEASURED on this tree — 1,049 signature lines / 55,644 bytes written to the marker took a GENUINE finding's report from 3,647 bytes to **18**, byte-identical to a clean session. Pinned as the open pole at `delegation-default` case 98 and `fleet-drain` case 81, each written so that the case going FALSE means an unforgeable key landed and THIS text is stale.

**What would close it.** An HMAC over the signature keyed on a per-install secret, so a marker not written by this install does not verify. That is `state-file-write-guard.md` Rule 4's doctrine one layer down — a keyless artifact proves integrity, never authenticity, and under the bounded-trust threat model (`multi-operator-coordination.md` §1: the adversary is a legitimate team member WITH repo write access) a keyless marker is no control at all, because the attacker recomputes it for free. It needs a per-install secret to EXIST, and no secret-management facility exists in this repo to hold one. Making the path merely harder to GUESS is BLOCKED as a substitute: it reproduces exactly the defect Rule 4 names.

```text
# DO — cite the read hardening for what it covers, and the write half as OPEN
"symlinked / out-of-tree markers are refused (cases 95/97/109); a pre-planted IN-TREE marker still suppresses (case 98)"
# DO NOT — cite the containment work as closing the suppression class
"the marker read is hardened, so advisory suppression is handled"
```

**Status: ACCEPTED, not deferred.** No Phase-2 row, no expiry, and none is owed. The blocker is a MISSING FACILITY, not unscheduled work, and booking a dated debt against a facility nobody has committed to build is the permanent-by-default shape MUST-5(b) forbids — the deferral would read to every later reader as a scheduled fence. Accepted by the co-owner — the named human in a standing role `completion-criterion.md` MUST-6 requires — on the session that measured it. The revisit TRIGGER is a per-install secret facility landing, an observable event; the deviation from MUST-6's calendar backstop is recorded HERE rather than papered over with a date nobody chose. The acceptance is a BET, logged and owned, never a claim that suppression is harmless.

**Why:** the hardening that closed the read half is the exact thing that makes the write half easy to miss — every symlink and containment case goes green, the suite reads as covered, and the cheapest attack on the hook needs no symlink at all.

No Trust Posture Wiring block is carried, and its absence is stated rather than left to inference: this section declares NO new MUST, MUST NOT, or BLOCKED-rationalization surface — it records the scope of a defense that already shipped. `trust-posture.md` MUST-8's canonical-8-field shape governs clauses that create obligations; minting a severity, grace period and violation scope for a record of what is NOT built would book enforcement against nobody.

## MUST NOT

- **Raw `process.exit(2)` or `process.exit(1)` at any halting branch.**

**Why:** Bypasses the canonical shape and ships an empty payload to both user and agent. The setTimeout fallback (`cc-artifacts.md` Rule 7) is the ONLY legitimate raw-exit path, and it MUST emit `{continue: true}` first.

- **`severity: "block"` on a finding whose evidence field is the matched regex span.**

**Why:** If the evidence is a regex match, the signal is lexical by definition. Block severity demands structural evidence (env var, exit code, file presence, AST shape). Lexical evidence and block severity together define the false-positive failure mode this rule blocks.

- **In-hook shell expansion via `child_process` to "resolve" shell variables for detector input.**

**Why:** Re-executing user-provided command strings inside the hook is a confused-deputy security hole AND blocks on the same issues (variables defined in the user's shell that the hook's shell does not have). The skip is the only correct disposition.

- **Detectors that block work the agent has been instructed to perform, when the structural fact (cwd, env) confirms in-scope.**

**Why:** A detector whose false-positive rate exceeds its true-positive rate on legitimate sessions IS a worse failure mode than the rule it enforces. `repo-scope-discipline.md` is enforced primarily through agent prose discipline (`detectRepoScopeDriftText`); the bash detector is a belt-and-suspenders surface that MUST NOT block when the structural signal (cwd basename + posture-gate clearance) confirms in-scope work.

Depth — the three Trust-Posture Wiring blocks (MUST-1..4, MUST-5, MUST-7), the length rationale and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/hook-output-discipline.md`, which every validator reads as part of this rule.

<!-- /slot:neutral-body -->
