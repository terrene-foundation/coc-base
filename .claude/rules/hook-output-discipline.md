---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/hooks/**"
  - "**/.claude/variants/**/hooks/**"
  - "**/.claude/test-harness/**"
---

# Hook Output Discipline — No Raw exit(2)

<!-- slot:neutral-body -->

Hooks are the structural enforcement layer of the trust-posture system. A block refuses ONE call — exit code `2` plus `permissionDecision: "deny"` and its reason — and hands that reason to the agent to resolve; the agent receives ONLY what the hook emits. It does NOT end the agent's turn: `lib/instruct-and-wait.js` no longer emits `continue: false` on a block (operator directive 2026-09-25, `8e0f74c64`), because that field stopped the whole session and left an already-answered refusal waiting on a human. A hand-rolled `continue: false` would still halt at the NON-STOP_LIKE events, which is why MUST-1 below still names it. **At `Stop` / `SessionEnd` / `PreCompact` that sentence is FALSE and the scoping is load-bearing:** `continue: false` was MEASURED INERT at `Stop` (2026-08-20, isolated `claude -p` probe, three arms on one tree) — its output was byte-indistinguishable from a control emitting no fields at all, and the hook did not re-fire. The mechanism that returns control to the model there is `decision: "block"` + `reason`, which MUST-6 governs. An unscoped reading of this sentence is what sends an author reaching for `continue: false` at a Stop hook and measuring nothing. A raw `process.exit(2)` with no payload tells the user "Execution stopped by PostToolUse hook" with no actionable content, and tells the agent nothing — institutional knowledge of WHY the block fired is lost the moment continuation halts.

This rule binds every hook in `.claude/hooks/**` to the canonical `instruct-and-wait.js::emit()` shape. It also forbids the false-positive class that ships `severity: "block"` from a lexical regex match alone — block severity requires a structural / behavioral / AST signal that the regex cannot evade by surface rewrite.

Pairs with `cc-artifacts.md` Rule 7 (timeout fallback), `trust-posture.md` § "Two-Phase Rollout" (block teeth at L2/L3), and `instruct-and-wait.js` library (the canonical shape this rule mandates).

## MUST Rules

### 1. Every Halting Hook MUST Emit The Full instructAndWait Shape

Any hook that returns `continue: false` (PostToolUse / UserPromptSubmit / SessionStart) OR exits with code `2` (PreToolUse only) MUST construct its output via `lib/instruct-and-wait.js::emit()` with all six fields populated: `severity`, `what_happened`, `why`, `agent_must_report` (≥1 entry), `agent_must_wait`, `user_summary`. Raw `process.exit(2)` and bare `process.stdout.write(JSON.stringify({continue: false}))` are BLOCKED.

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

```javascript
// DO — skip when captured group references shell variable
const m = command.match(/\bgh\b[^|;]*--repo\s+([^\s]+)/);
if (!m) return null;
const targetRepo = m[1];
// Pre-expansion shell variable cannot be evaluated at hook invocation time.
if (/^\$\{?\w+\}?$/.test(targetRepo) || /\$\(/.test(targetRepo) || /`/.test(targetRepo)) {
  return null;
}
// ... proceed with literal-string comparison

// DO NOT — evaluate the literal "$REPO" string against cwd basename
const cwdBase = path.basename(cwd);
if (!targetRepo.includes(cwdBase)) return { severity: "block", ... };  // false positive
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
# DO — fixture set covers the three predicate classes
.claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/
  clean-current-repo.txt              ← "gh issue list --repo current-org/current-repo"; expects null
  flag-explicit-other-repo.txt        ← "gh issue list --repo other-org/other-repo"; expects halt-and-report
  skip-shell-variable.txt             ← "gh issue list --repo \"$REPO\""; expects null (Rule 3)
  skip-command-substitution.txt       ← "gh issue list --repo $(gh repo view -q .nameWithOwner)"; expects null

# DO NOT — only happy-path fixture; shell-variable regression silently re-introduced
.claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/
  flag-explicit-other-repo.txt
```

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

```javascript
// DO — dispatch on the parsed subcommand POSITION; the verb is where the grammar puts it
for (const g of parseGitInvocations(cmd)) {
  if (
    FENCED.has(g.sub) &&
    !isNonMutating(g.argv, VALUE_FLAGS[g.sub], NON_MUTATING[g.sub])
  )
    return {
      rule_id: "trust-posture/L3",
      severity: "block",
      evidence: `parsed verb: git ${g.sub}`,
    };
}

// DO — a lexical PROPOSITION, exactly determinable: is this literal token present in this file set?
if (publishedFiles.some((f) => read(f).includes(PRIVATE_TOKEN)))
  return {
    rule_id: "artifact-flow/disclosure",
    severity: "block",
    evidence: `token in ${f}`,
  };

// DO NOT — regex over the joined string, then `block`
if (/\bgit\s+commit(?![\w-])/.test(cmd))
  return { severity: "block", evidence: cmd };
// `git -C /other/repo commit` walks straight through; `echo "git commit -m x"` fires it.

// DO NOT — "repair" the regex by scanning the SAME joined string for a non-mutating marker
if (/\bgit\s+commit/.test(cmd) && !/--dry-run|--help|-n/.test(cmd))
  return { severity: "block", evidence: cmd };
// `git commit -m "fix the --dry-run bug"` now passes — the flag-shaped token was a flag's VALUE;
// and `-n` is `--no-verify` on commit (which COMMITS) but `--dry-run` on push, so one shared
// marker list gets exactly one of the two wrong, in the dangerous direction.
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

## Trust Posture Wiring

- **Severity:** `halt-and-report` (the agent surfaces the rule + remediation in-turn; not a block).
- **Grace period:** 7 days from rule landing (2026-05-06 → 2026-05-13). During grace, `detect-violations.js` does NOT auto-emergency-downgrade for new hook authoring that ships a raw-exit branch — but the SessionStart trust-gate banner names the rule and any violation logs to `violations.jsonl` for `/codify` review.
- **Cumulative posture impact:** same-class violations (a `severity: "block"` returned on a lexical signal
  with no structural guard; a raw `process.exit(2)` branch outside the timeout fallback; a guard invoking
  the disclosure-isolation exception without satisfying condition (a), or describing its signal as
  structural when it is not) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule
  in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any hook authored OR modified in `.claude/hooks/**` within the grace period that ships a raw `process.exit(2)` branch OR a `severity: "block"` finding without structural-signal evidence triggers emergency downgrade L5 → L4 per `trust-posture.md` MUST Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: hook-output-discipline]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set by `/codify` at land-time, cleared after grace expires).
- **Detection mechanism:** `cc-architect` mechanical sweep at `/codify` validation. **Probes: REGISTERED — `.claude/test-harness/probes/hook-output-discipline.probes.json`**, 20 rows in 10 bipolar `pair_id` pairs: one firing pair per derived clause (MUST-1..MUST-7, plus the `## MUST NOT` section read as a SET), a `MUST-2-exception-firing` pair scoped to the DISCLOSURE-ISOLATION exception nested inside MUST-2, and a surface-equalized meta-compliance pair, with candidate fixtures + answer-key sidecars at `.claude/audit-fixtures/hook-output-discipline/`. The row and pair figures are the 2026-09-13 measurement (the prior 18/9 described the tree before the exception pair landed); re-derive rather than citing them. Registered in `eval-manifest.json` as a probe-only entry (`scanner: null`), pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`, and declared in `clause-coverage-baseline.json` with ZERO deferred clauses. Registration buys DISPATCHABILITY, never automatic execution: no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a green CI run is NEVER evidence these probes passed — they execute only when an orchestrator dispatches `/test-harness-probe --artifacts` at gate-review. **Consumer note:** `.claude/test-harness/**` is never-synced (MEASURED `skip/exclude` on all six lanes this rule ships to), so no consumer receives the suite; the fixtures directory DOES ship (`copy/tier_match` on the same six).
  1. `grep -rn 'process\.exit([12])' .claude/hooks/` — every hit must be the timeout fallback (commented as such) OR the structured exit from `instruct-and-wait.js::emit()`.
  2. `grep -B5 'severity: "block"' .claude/hooks/lib/violation-patterns.js` — every block-severity return MUST have an env-var / exit-code / file-existence guard above it.
  3. AST sweep on detector functions: any function returning `severity: "block"` whose `evidence` field is a `match()` group is flagged.
  4. For any guard invoking the § MUST-2 DISCLOSURE-ISOLATION exception: confirm condition (a) holds —
     the block branch sits behind a structural boundary predicate independent of the scan — and that the
     block site SAYS it is invoking the exception rather than claiming its signal is structural.
- **Violation scope:** MUST-1 through MUST-4, including the MUST-2 DISCLOSURE-ISOLATION exception and its
  four conditions. **PROBE GAP: CLOSED 2026-09-13 — the exception now carries its own pair, and
  the ledger STILL cannot hold it.** An earlier revision of this bullet read "the
  DISCLOSURE-ISOLATION exception has NO probe pair" and closed "ACCEPTANCE OWED AND UNACCEPTED";
  the first half was true when written and is now FALSE, and the second is withdrawn — the
  co-owner directed that the pair be BUILT rather than the residual accepted, so no acceptance
  is owed by anyone. The graduation condition this bullet set is the one that was met: a bipolar
  `MUST-2-exception-firing` pair whose VIOLATION pole is a guard invoking the exception while
  still describing its signal as structural. Both poles satisfy all four conditions and ship the
  same `block` on the same content scan; they separate on whether the block site NAMES the
  exception or attributes the block to the boundary in front of it. What has NOT changed is the
  ledger limit, RE-MEASURED on this tree rather than inherited: adding a `MUST-2-EXCEPTION` row
  to `clause-coverage-baseline.json` still reds `check-clause-coverage.mjs` with
  `R5-orphan-declared-clause` AND `R2-false-coverage-claim`, because derivation is at MUST-N
  granularity and a named exception nested inside a clause has no row it could occupy. The pair
  therefore declares `covers: ["MUST-2"]`, which is the honest scope the ledger can express, and
  `check-clause-coverage.mjs` output is byte-identical before and after it landed — so a green
  clause-coverage run is NOT evidence this pair exists. The pair's presence is witnessed by the
  suite itself and by `probe-suite-integrity.test.mjs`, which names the pair when it is broken.
  MUST-5 and MUST-7 keep their own clause-scoped blocks below. Every `violations.jsonl`
  row names the hook, the emitted severity, and the signal the severity rested on.
- **Origin:** 2026-05-06 (see MUST-2 § Why — `detectRepoScopeDriftBash` hard-blocked `gh issue list
--repo "$REPO"` on a pre-expansion literal). The DISCLOSURE-ISOLATION exception was added 2026-09-11 by
  owner direction after an audit of every `severity: "block"` origination in `.claude/hooks/**` found
  `cross-ecosystem-disclosure-guard.js` blocking on a content scan while its comments claimed a structural
  primitive; this block's grandfathered exemption ends with that edit per `trust-posture.md` MUST-8, on
  the precedent `zero-tolerance.md` § Rule 3e wiring set.

## Trust Posture Wiring — Parsed-Signal Detector Doctrine (MUST-5)

Applies to the **MUST-5** clause ONLY (added 2026-08-06). Per `trust-posture.md` MUST-8 grandfather cutoff this clause lands AT/AFTER the MUST-8 SHA and ships canonical-8-field-compliant; the pre-existing § Trust Posture Wiring block above (MUST-1 through MUST-4) stays grandfathered until itself `/codify`-touched — the clause-scoped precedent `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge set.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm that a detector authored or planned to carry `block` names a parsed/structural signal, and that a rule whose property is lexical-only declares its detection permanently advisory rather than filing a Phase-2 enforcement deferral); `halt-and-report` at the hook layer for the (a) half ONLY, which `.claude/hooks/block-evidence-guard.js` now emits at `PostToolUse:Edit|Write` AT LOOM ONLY — the guard is fenced `loom_only` and reaches no consumer, where the hook layer for the (a) half is therefore absent and gate-review is the whole of it; see § Detection mechanism for that three-part state, for why `halt-and-report` is the ceiling, and why MUST-2's lexical bar is not what sets it. For the (b) half the hook layer stays **`advisory`-at-most and in practice absent**: whether a NAMED signal is genuinely structural is judgment-bearing over the detector's semantics, with no tool-call-time signal, so `block` is unavailable to it under MUST-8's own severity mapping; declaring that plainly is the clause obeying itself. An earlier revision made the `advisory`/no-tool-call-time-signal claim rule-wide; that was true when written and became false when the (a)-half detector landed, so it is scoped here rather than left standing.
- **Grace period:** 7 days from clause landing (2026-08-06 → 2026-08-13).
- **Cumulative posture impact:** same-class violations (a `block`-intended detector dispatching on a regex over a joined command string / raw file text / agent prose; a lexical-only property filed as `Phase 2 (deferred)` enforcement instead of declared permanently advisory) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: whether a named signal is structural is a judgment-bearing property of the detector's semantics, resolvable only at the review layer, and minting a key would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, `issue-triage-routing.md`, and `instrument-discipline.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: hook-output-discipline]` IFF `posture.json::pending_verification` includes the `hook-output-discipline` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any change that (a) authors or modifies a detector in `.claude/hooks/lib/violation-patterns.js` or a hook returning a severity, confirming a `block` return names a parsed/structural signal and not a `match()` span (this composes with the existing § Trust Posture Wiring sweep above, whose step 3 already AST-flags that shape); or (b) writes a `**Detection mechanism:**` Wiring field, confirming any `Phase 2` row names a concrete structural signal, and that a lexical-only property is declared permanently advisory instead. **The (b) half is NOT awaiting a detector, and this clause may not file one:** whether a _named_ signal is genuinely structural is exactly the semantic judgment MUST-5 says no lexical predicate can make, so a detector for it would instance the class it forbids — the same disposition `hook-event-selection.md` recorded for its semantic half and `instrument-discipline.md` for its own. **The (a) half is ARMED AT LOOM as of 2026-09-13 and deliberately FENCED FROM CONSUMERS — a co-owner-approved STAGED rollout.** An earlier revision of this row read "No such check exists today and nothing MECHANICALLY enforces this clause"; BOTH halves are now superseded — the check exists, and at loom it is dispatched. A later revision said it was "AUTHORED but UNWIRED, so it enforces nothing"; that was true when written and is now FALSE at loom, though it remains exactly true at every consumer, which is the three-part state this row now records rather than collapsing to one. The check this clause described in the conditional — a `validate-emit.mjs`-class assertion that no `severity: "block"` return in `violation-patterns.js` carries a `match()`-derived `evidence` field — is built. The predicate is **`.claude/hooks/lib/block-evidence-provenance.js`** and the detector that would run it is **`.claude/hooks/block-evidence-guard.js`**. It IS registered in `.claude/settings.json` at **`PostToolUse`, matcher `Edit|Write`** — the event and matcher its own `@hook-event` header declares, MEASURED on this tree against a known-absent control — so AT LOOM it fires. **ARMED is not PROVEN EFFECTIVE:** no armed guard has been OBSERVED firing in a live session; registration and distribution state are all that is measured. **It reaches NO consumer:** the hook file is deliberately fenced `loom_only` in `sync-manifest.yaml` with its required twin in `validate-emit.mjs::LOOM_ONLY_TIER_CARVEOUTS`, so it does not ship — a consumer receives this RULE and not this DETECTOR, enforcement at those targets is the Phase-1 gate-review above ONLY, its silence there is the ABSENCE OF AN INSTRUMENT rather than evidence that no lexically-evidenced `block` shipped, and the gap is DECLARED in the detector-distribution baseline registry (`detector-distribution-baseline.json`, under the test-harness tree) rather than left silent. **Staged because firing volume is measured on loom's corpus and nowhere else, and a consumer's corpus is a different population.** PROMOTION is deleting this guard's `loom_only:` entry TOGETHER WITH its `LOOM_ONLY_TIER_CARVEOUTS` twin — removing either alone is a defect. The event is the `verification` class per `hook-event-selection.md` (the subject is the hook source as it stands ON DISK after the edit, which is the only moment it exists; `NotebookEdit` is deliberately excluded rather than inherited from the adjacent registration block, because no notebook can author `.claude/hooks/**.js` and claiming it would make the marker over-state its surface under MUST-4). Its **severity is `halt-and-report`, and MUST-2's lexical bar is NOT what caps it** — the signal is a token-structural source fact, which MUST-2 admits. Two other things do, both stated rather than assumed: (i) the check is a PROXY for the clause, since "the evidence quotes a match span" strongly correlates with a lexical dispatch without being identical to it, and closing that last step is the (b)-half judgment this same row declares unmechanizable; (ii) the EVENT — at `PostToolUse` the edit has already landed, and `block` there was MEASURED against the shared renderer (fixture ARM G) to return `{continue:false}` with exit 2, so `block` on a proxy would wedge an in-flight edit. The predicate LEXES JavaScript rather than grepping it, and that is load-bearing rather than fastidious: `violation-patterns.js` itself carries the literal `severity:block` twice in PROSE COMMENTS about this very rule, so a grep-shaped check would open with two false positives on its own rule's commentary. Fixtures: **`.claude/audit-fixtures/parsed-signal-detector/run.mjs`**, bipolar throughout — every firing arm carries a near-miss opposite pole (a `block` on a parsed field; a `block` on an env/path fact; the SAME `evidence: m[0]` line under `halt-and-report`; a commented-out `severity: "block"` inside a real return object) — with five mutants, each carrying a reach proof, and an arm that PINS the four declared blind classes as misses rather than describing them. Counts are a measurement and go stale, so re-derive rather than citing: at landing the battery reported 80/80 cases and 5/5 mutants killed on the `codify/<operator>-2026-09-13-deferral-burndown` tree. **What RUNS it is registration in `.claude/test-harness/ci-audit-fixtures.json`**, a registry closed in both directions — an unregistered runner and an entry with no file are each a hard build failure — so unlike the LLM-judge probe suites this tier EXECUTES in CI rather than merely being dispatchable. The Phase-1 gate-review above is unchanged and still owns the (b) half. The SEMANTIC tier also still ships: the `MUST-5-firing` bipolar pair in `.claude/test-harness/probes/hook-output-discipline.probes.json`, whose compliant pole files one genuine `Phase 2` row — for the enumerated-literal-token half — so a judge keying on that token's mere presence flags the clean pole. That tier is LLM-judge and DISPATCH-ONLY; it does not stand in for the structural tier above, and a green CI run is never evidence it passed. Reference implementation for the (a) half: `.claude/hooks/lib/git-command-parse.js` + the `posture-gate.js` mutation fence — landing via **loom#1589**, cited by PR rather than commit for the reason given at MUST-5 § Why; unmerged at authoring time, NOT on `main`. **Read that reference as a parsed-signal EXEMPLAR, not as a complete fence:** an adversarial round measured seven bypass classes still open against it (wrapper forms — `eval`, `sh -c`, `bash -c`, `xargs`, command-name-slot substitution, `$IFS` fusion — plus an unindented line continuation since closed). The parser is the right SIGNAL; recognising every invocation that reaches a shell is a separate and unfinished problem, and a reader who takes the exemplar as finished would inherit exactly the over-claim this rule exists to block.
- **Violation scope:** MUST-5(a) (an enforcing detector dispatching on a lexical signal) + MUST-5(b) (a lexical-only property filed as a Phase-2 enforcement deferral rather than declared permanently advisory). Every `violations.jsonl` row names the detector or rule clause and the signal it dispatches on.
- **Origin:** See § Origin — MUST-5 paragraph.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Body exceeds the 200-line guidance (it did so before MUST-5 landed; MUST-5 extends the overage). Named rationale: **one contract, seven interlocking clauses.** This rule is the whole hook-authoring contract — emit shape (MUST-1), signal-to-severity (MUST-2), shell-variable skip (MUST-3), fixtures (MUST-4), signal SELECTION (MUST-5), `Stop`-hand-back refusal (MUST-6), delivery CHANNEL (MUST-7) — and each carries the DO/DO-NOT + BLOCKED corpus + `**Why:**` the meta-rule mandates. MUST-2 and MUST-5 are two halves of one obligation and split across files would drift, which is the failure this rule exists to name; MUST-7 is likewise the second half of MUST-1 (what to report / how it reaches anyone) and separating them would let a hook satisfy one while defeating the other's purpose. Depth is extracted, not inline: the 13-case control and the classification inventory live in the lane report cited at § Origin (MUST-5). Sibling precedent: the `security.md` + `artifact-flow.md` length rationales.

Origin (MUST-5): 2026-08-06 — the `#65` enforcement-registration wave. loom's `posture-gate.js` L3 fence carried a file comment reading "block commit/push/PR" while every branch emitted `halt-and-report`, because its signal was five flat regexes over the raw command string and MUST-2 correctly forbids `block` on that; the fence could only ever annotate. The general form surfaced in the same wave: 59 `Phase 2` rows across 43 rules' `**Detection mechanism:**` fields, a large share of them against properties (agent prose, semantic adequacy, intent) no structural predicate can observe — deferrals recording enforcement that cannot arrive. Classification inventory + the 13-case three-arm control behind the § Why measurements: (loom-internal reference).

Origin: 2026-05-06 — `detectRepoScopeDriftBash` blocked an in-scope `gh issue list --repo "$REPO"` sweep in the Rust SDK because the regex captured the literal string `"$REPO"` pre-expansion. User-identified codification gap: the `instruct-and-wait.js` library shipped 2026-05-05 but no rule mandated its use, leaving every future detector free to regress to raw exit. Same false-positive class as the heredoc/segment-anchor and `git commit -m`/`-F` skip clauses already addressed in `validate-bash-command.js` (commit `0366a68`); applies the lesson at the design-time rule layer rather than per-detector patches.

## Trust Posture Wiring — Refusal Delivery Channel (MUST-7)

Applies to the **MUST-7** clause ONLY (added 2026-08-17; numbered MUST-7 at landing because `Stop`-hand-back refusal took the MUST-6 slot first — the clause is unchanged, only its ordinal moved). Per `trust-posture.md` MUST-8 grandfather cutoff this clause lands AT/AFTER the MUST-8 SHA and ships canonical-8-field-compliant; the § Trust Posture Wiring block (MUST-1..4), the MUST-5 block, and MUST-6 each stay on their own wiring until themselves `/codify`-touched — the clause-scoped precedent `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge set, and the one this file already followed for MUST-5.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/implement` confirm that any hook authored or modified to halt renders the shared delivery instruction, and that no payload was hand-rolled with a report but no channel); `block` at the hook layer is NOT claimed and is unavailable — whether a given wording is correct for both readers is an LLM-judgment property of prose, which MUST-2 caps at advisory. What IS structural — that the shared constant is present in the rendered body — is enforced mechanically by the suite named below rather than by a hook.
- **Grace period:** 7 days from clause landing (2026-08-17 → 2026-08-24).
- **Cumulative posture impact:** same-class violations (a halting hook emitting `agent_must_report` with no delivery channel; a hand-written per-hook channel variant instead of the shared constant; a channel naming only the subagent reader or only the top-level reader) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the judgment half (is this wording correct for both readers) is review-layer-only, the structural half is already CI-enforced and needs no posture key to have teeth, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition MUST-5 above, `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge and `instrument-discipline.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: hook-output-discipline]` IFF `posture.json::pending_verification` includes the `hook-output-discipline` rule_id (shared rule_id; one ack covers MUST-1..7).
- **Detection mechanism:** **structural, SHIPPED, and EXECUTING — the enforcement for this clause exists today; nothing about it is scheduled, deferred, or owed.** The enforcing check is `.claude/test-harness/tests/refusal-delivery-channel.test.mjs`, registered `mode: bulk` in `.claude/test-harness/ci-suites.json` — a registry closed in BOTH directions, so an unregistered suite is a hard build failure and this one cannot silently stop running. It pins, over the full 7-event × 6-severity matrix, that a report-bearing payload carries the exported `DELIVERY_INSTRUCTION`, that both audience branches ship, that the concrete `SendMessage` token is present, and — as the anti-vacuity control — that a payload with nothing to report carries NO channel, so the probe is demonstrably not a constant. Its two mutation rows (instruction excised from the render path; `SendMessage` genericized back to "user") each carry a REACH proof and a RAN proof per `instrument-discipline.md` MUST-2(b); re-measured against the shipped file on the rebased tree (2026-08-23) they red 5/14 and 2/14 respectively, each with a REACH proof taken before the run — MUTANT-1's rendered body loses the channel block, MUTANT-2's exported constant loses the `SendMessage` token, so neither mutation is inert — with the restored file green 14/14. The figures previously recorded here (5/12, 3/12, 12/12) were stale: the suite has carried 14 tests since it was authored, so the denominator was never 12. Counts are a measurement and go stale; re-derive rather than citing this line. **What registration buys is EXECUTION here, not merely dispatchability** — `run-harness-suites.mjs` runs every `bulk` row in the aggregate CI step, unlike the LLM-judge probe suites the loom↔csq boundary keeps out of CI. Phase 1 (gate-review) covers the residual JUDGMENT half only: whether a newly-authored wording is genuinely true for both readers. A SEMANTIC tier now also ships — the `MUST-7-firing` bipolar pair in `.claude/test-harness/probes/hook-output-discipline.probes.json`, fixtures at `.claude/audit-fixtures/hook-output-discipline/`, whose compliant pole quotes BOTH forbidden shortcuts (the bare report-to-user line and the SendMessage-only trim) in order to refuse them, so a judge keying on their presence flags the clean pole. It is LLM-judge and DISPATCH-ONLY, so the STRUCTURAL tier above remains where this clause's teeth are. **Consumer note:** `.claude/test-harness/tests/refusal-delivery-channel.test.mjs` does not ship to use/base, build/base, use/py, build/py, use/rs, build/rs (MEASURED: `skip` on 6 of this rule's 6 lanes), so no consumer on those lanes receives it; at those targets this tier is not a live gate. The same holds for `.claude/test-harness/ci-suites.json` on the same 6 lanes, by the same measurement. Both gaps are declared in the detector-distribution baseline registry — deliberately named in prose rather than as a path token, because citing it as one would make the registry itself a cited detector needing its own declaration, the recursion this sentence exists on the far side of. What a consumer DOES receive is the enforced BEHAVIOUR: `.claude/hooks/lib/instruct-and-wait.js` rides the always-included hooks surface, so every lane gets the channel-naming payload — only the suite that pins it is loom-side.
- **Violation scope:** MUST-7 ONLY (a halting payload rendering a report with no delivery channel; a hand-rolled per-hook channel variant; a channel correct for only one of the two readers). Every `violations.jsonl` row names the hook and which of the three shapes fired. MUST-1..6 keep their existing scope under their own blocks.
- **Origin:** See § Origin — MUST-7 paragraph.

Origin (MUST-7): 2026-08-17 — three lanes in one session went idle after a CORRECT hook refusal, each holding uncommitted work with no reflog (7 files; 286 insertions; a reader+writer pair), all three recovered only by an orchestrator's `git status --porcelain` sweep on a hunch. Diagnosed by one of the affected lanes: "the refusal arrives as a tool error, and its instruction is 'report to user' — an agent that reads 'do not retry the same form' and has no other channel open will re-plan silently. The refusal text has no 'and tell your orchestrator' step." Measured surface at authoring, with a fired control: of 45 hook files, 24 require the shared renderer and 20 of those can carry `block` or `halt-and-report`; ALL 20 route through the single `buildValidationBody`, and all 59 emitting call sites pass `agent_must_report` (58 literally, 1 by spread) — so a one-constant fix in the one renderer reaches the whole refusal surface, and no per-hook edit was made or needed. The only other copy of that renderer, `.claude/test-harness/trust-posture-poc/lib/instruct-and-wait.js`, is a FROZEN pre-#466 snapshot its own header forbids syncing to, and is deliberately untouched.

<!-- /slot:neutral-body -->
