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

Hooks are the structural enforcement layer of the trust-posture system. A hook that returns `continue: false` (or exits with code `2` at PreToolUse) halts the agent's flow — and the agent receives ONLY what the hook emits. A raw `process.exit(2)` with no payload tells the user "Execution stopped by PostToolUse hook" with no actionable content, and tells the agent nothing — institutional knowledge of WHY the block fired is lost the moment continuation halts.

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
- **Regression-within-grace:** any hook authored OR modified in `.claude/hooks/**` within the grace period that ships a raw `process.exit(2)` branch OR a `severity: "block"` finding without structural-signal evidence triggers emergency downgrade L5 → L4 per `trust-posture.md` MUST Rule 4.
- **Receipt requirement:** SessionStart MUST require `[ack: hook-output-discipline]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set by `/codify` at land-time, cleared after grace expires).
- **Detection mechanism:** `cc-architect` mechanical sweep at `/codify` validation:
  1. `grep -rn 'process\.exit([12])' .claude/hooks/` — every hit must be the timeout fallback (commented as such) OR the structured exit from `instruct-and-wait.js::emit()`.
  2. `grep -B5 'severity: "block"' .claude/hooks/lib/violation-patterns.js` — every block-severity return MUST have an env-var / exit-code / file-existence guard above it.
  3. AST sweep on detector functions: any function returning `severity: "block"` whose `evidence` field is a `match()` group is flagged.

Origin: 2026-05-06 — `detectRepoScopeDriftBash` blocked an in-scope `gh issue list --repo "$REPO"` sweep in kailash-rs because the regex captured the literal string `"$REPO"` pre-expansion. User-identified codification gap: the `instruct-and-wait.js` library shipped 2026-05-05 but no rule mandated its use, leaving every future detector free to regress to raw exit. Same false-positive class as the heredoc/segment-anchor and `git commit -m`/`-F` skip clauses already addressed in `validate-bash-command.js` (commit `0366a68`); applies the lesson at the design-time rule layer rather than per-detector patches.

<!-- /slot:neutral-body -->
