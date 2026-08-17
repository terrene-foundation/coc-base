---
id: "HOOK-OUTPUT-DISCIPLINE"
paths: ["**/.claude/hooks/**", "**/.claude/variants/**/hooks/**", "**/.claude/test-harness/**"]
---

# Hook Output Discipline — No Raw exit(2)

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

### 5. A Detector Meant To ENFORCE Dispatches On A Parsed Signal; A Lexical-Only One Is Declared PERMANENTLY Advisory

MUST-2 governs what a lexical signal may not CARRY. This is its other half — what the author owes BEFORE the severity question is reachable.

**(a) Signal selection.** A detector authored or planned to FENCE (to carry `block`) MUST dispatch on a signal a surface rewrite cannot evade: an argv token POSITION from a real parse, an AST node, a parsed-document field (frontmatter value, Dockerfile instruction, manifest key), a filesystem or git-object fact, or a process/tool-event read. Naming a regex over a joined command string, a file's raw text, or agent prose as the mechanism for an ENFORCING detector is BLOCKED — MUST-2 caps that signal at advisory, so it ships as noise no matter what the author intended.

**(b) Honest declaration.** When the property is observable ONLY lexically, the rule MUST declare its detection **permanently advisory** and name the semantic half as not mechanizable. Filing it instead as `Phase 2 (deferred)` enforcement is BLOCKED: the deferral books a debt that cannot be paid, and every later reader reads a permanent advisory as a scheduled fence. `hook-event-selection.md`'s "Phase 2 is NOT deferred-pending-a-detector — no structural predicate for the semantic half is believed to exist" is the canonical form.

**The discriminator is the PROPOSITION, not the technique.** String matching is not the defect. A check asserting that a LITERAL token is absent from an enumerated file set is exact and structural however it is spelled. A check inferring intent, adequacy, or completeness from prose is not, however carefully its regex is written. Ask what the check ASSERTS, then ask whether a rewrite preserving the meaning changes the answer.

```javascript
// DO — dispatch on the parsed subcommand POSITION; the verb is where the grammar puts it
for (const g of parseGitInvocations(cmd)) {
  if (FENCED.has(g.sub) && !isNonMutating(g.argv, VALUE_FLAGS[g.sub], NON_MUTATING[g.sub]))
    return { rule_id: "trust-posture/L3", severity: "block", evidence: `parsed verb: git ${g.sub}` };
}

// DO — a lexical PROPOSITION, exactly determinable: is this literal token present in this file set?
if (publishedFiles.some((f) => read(f).includes(PRIVATE_TOKEN)))
  return { rule_id: "artifact-flow/disclosure", severity: "block", evidence: `token in ${f}` };

// DO NOT — regex over the joined string, then `block`
if (/\bgit\s+commit(?![\w-])/.test(cmd)) return { severity: "block", evidence: cmd };
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
- **Detection mechanism:** `cc-architect` mechanical sweep at `/codify` validation: Probes `.claude/test-harness/probes/hook-output-discipline.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`.
  1. `grep -rn 'process\.exit([12])' .claude/hooks/` — every hit must be the timeout fallback (commented as such) OR the structured exit from `instruct-and-wait.js::emit()`.
  2. `grep -B5 'severity: "block"' .claude/hooks/lib/violation-patterns.js` — every block-severity return MUST have an env-var / exit-code / file-existence guard above it.
  3. AST sweep on detector functions: any function returning `severity: "block"` whose `evidence` field is a `match()` group is flagged.

## Trust Posture Wiring — Parsed-Signal Detector Doctrine (MUST-5)

Applies to the **MUST-5** clause ONLY (added 2026-08-06). Per `trust-posture.md` MUST-8 grandfather cutoff this clause lands AT/AFTER the MUST-8 SHA and ships canonical-8-field-compliant; the pre-existing § Trust Posture Wiring block above (MUST-1 through MUST-4) stays grandfathered until itself `/codify`-touched — the clause-scoped precedent `security.md` § Enforcement-Surface Parity and `git.md` § CI-check/merge set.

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm that a detector authored or planned to carry `block` names a parsed/structural signal, and that a rule whose property is lexical-only declares its detection permanently advisory rather than filing a Phase-2 enforcement deferral); `advisory` at the hook layer per MUST-2 — whether a named signal is genuinely structural is judgment-bearing over the detector's semantics, with no tool-call-time signal. Per MUST-8's own severity mapping this clause is LLM-judgment-bearing, so `block` is unavailable to it; declaring that plainly is the clause obeying itself.
- **Grace period:** 7 days from clause landing (2026-08-06 → 2026-08-13).
- **Cumulative posture impact:** same-class violations (a `block`-intended detector dispatching on a regex over a joined command string / raw file text / agent prose; a lexical-only property filed as `Phase 2 (deferred)` enforcement instead of declared permanently advisory) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: whether a named signal is structural is a judgment-bearing property of the detector's semantics, resolvable only at the review layer, and minting a key would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, `issue-triage-routing.md`, and `instrument-discipline.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: hook-output-discipline]` IFF `posture.json::pending_verification` includes the `hook-output-discipline` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — cc-architect at `/codify` + reviewer at `/redteam` inspect any change that (a) authors or modifies a detector in `.claude/hooks/lib/violation-patterns.js` or a hook returning a severity, confirming a `block` return names a parsed/structural signal and not a `match()` span (this composes with the existing § Trust Posture Wiring sweep above, whose step 3 already AST-flags that shape); or (b) writes a `**Detection mechanism:**` Wiring field, confirming any `Phase 2` row names a concrete structural signal, and that a lexical-only property is declared permanently advisory instead. **Phase 2 is NOT deferred-pending-a-detector for the (b) half, and this clause may not file one:** whether a *named* signal is genuinely structural is exactly the semantic judgment MUST-5 says no lexical predicate can make, so a detector for it would instance the class it forbids — the same disposition `hook-event-selection.md` recorded for its semantic half and `instrument-discipline.md` for its own. The (a) half is structurally reachable and is claimed as reachable, NOT as shipped — it is this clause's ONE genuine **Phase 2** deferral, and the only Phase-2 token in this block that DECLARES rather than DISCUSSES one: a `validate-emit.mjs`-class check could assert that no `severity: "block"` return in `violation-patterns.js` has a `match()`-derived `evidence` field. **No such check exists today; nothing mechanically enforces this clause, and its ONLY active coverage is the Phase-1 gate-review above.** Audit fixtures land WITH that check at `.claude/audit-fixtures/parsed-signal-detector/` per `cc-artifacts.md` Rule 9; no fixtures are claimed now. Reference implementation for the (a) half: `.claude/hooks/lib/git-command-parse.js` + the `posture-gate.js` mutation fence — landing via **loom#1589**, cited by PR rather than commit for the reason given at MUST-5 § Why; unmerged at authoring time, NOT on `main`. **Read that reference as a parsed-signal EXEMPLAR, not as a complete fence:** an adversarial round measured seven bypass classes still open against it (wrapper forms — `eval`, `sh -c`, `bash -c`, `xargs`, command-name-slot substitution, `$IFS` fusion — plus an unindented line continuation since closed). The parser is the right SIGNAL; recognising every invocation that reaches a shell is a separate and unfinished problem, and a reader who takes the exemplar as finished would inherit exactly the over-claim this rule exists to block.
- **Violation scope:** MUST-5(a) (an enforcing detector dispatching on a lexical signal) + MUST-5(b) (a lexical-only property filed as a Phase-2 enforcement deferral rather than declared permanently advisory). Every `violations.jsonl` row names the detector or rule clause and the signal it dispatches on.
- **Origin:** See § Origin — MUST-5 paragraph.

**Length rationale (per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines").** Body exceeds the 200-line guidance (it did so before MUST-5 landed; MUST-5 extends the overage). Named rationale: **one contract, five interlocking clauses.** This rule is the whole hook-authoring contract — emit shape (MUST-1), signal-to-severity (MUST-2), shell-variable skip (MUST-3), fixtures (MUST-4), signal SELECTION (MUST-5) — and each carries the DO/DO-NOT + BLOCKED corpus + `**Why:**` the meta-rule mandates. MUST-2 and MUST-5 are two halves of one obligation and split across files would drift, which is the failure this rule exists to name. Depth is extracted, not inline: the 13-case control and the classification inventory live in the lane report cited at § Origin (MUST-5). Sibling precedent: the `security.md` + `artifact-flow.md` length rationales.

Origin (MUST-5): 2026-08-06 — the `#65` enforcement-registration wave. loom's `posture-gate.js` L3 fence carried a file comment reading "block commit/push/PR" while every branch emitted `halt-and-report`, because its signal was five flat regexes over the raw command string and MUST-2 correctly forbids `block` on that; the fence could only ever annotate. The general form surfaced in the same wave: 59 `Phase 2` rows across 43 rules' `**Detection mechanism:**` fields, a large share of them against properties (agent prose, semantic adequacy, intent) no structural predicate can observe — deferrals recording enforcement that cannot arrive. Classification inventory + the 13-case three-arm control behind the § Why measurements: (loom-internal reference).

Origin: 2026-05-06 — `detectRepoScopeDriftBash` blocked an in-scope `gh issue list --repo "$REPO"` sweep in the Rust SDK because the regex captured the literal string `"$REPO"` pre-expansion. User-identified codification gap: the `instruct-and-wait.js` library shipped 2026-05-05 but no rule mandated its use, leaving every future detector free to regress to raw exit. Same false-positive class as the heredoc/segment-anchor and `git commit -m`/`-F` skip clauses already addressed in `validate-bash-command.js` (commit `0366a68`); applies the lesson at the design-time rule layer rather than per-detector patches.
