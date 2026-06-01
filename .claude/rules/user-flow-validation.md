---
name: user-flow-validation
description: Walk the actual user-facing flow before declaring any deliverable done. Tests passing is necessary but NOT sufficient. Receipts (verbatim command + verbatim output + user's next-step disposition) are mandatory.
priority: 10
scope: path-scoped
paths: ["**/*"]
---

# User-Flow Validation Rules

A deliverable MUST be exercised through the actual user-facing path before being declared "done". Passing tests (unit / integration / Tier-1 / Tier-2 / Tier-3) is **necessary but INSUFFICIENT** — the user's literal walk MUST be performed: invoke the command the user would invoke, observe the output the user would see, follow the next step the user would take. Declaring "done" before the walk is BLOCKED.

This rule fills the gap between `rules/testing.md` (test coverage discipline), `rules/zero-tolerance.md` Rule 6 (no half-implementations), and `rules/verify-resource-existence.md` MUST-2 (live-API existence checks). Tests verify primitives in isolation; the walk verifies the COMPOSITION of primitives + the actual user-facing surface (CLI argument parsing, terminal output rendering, session state, hook ordering, error message clarity, next-step legibility). The two are distinct. Only the literal walk catches the failure modes the test author did not think to check.

## MUST Rules

### 1. Walk The User Flow Before Declaring Complete

Before declaring ANY deliverable "done", "complete", "shipped", "landed", or "ready": invoke the command / load the rule / run the script the way the user will. Observe the actual output the user will see. Follow the next step the user would take. Tests passing is INSUFFICIENT — every gate-level test result is the test author's belief about what the user will experience, not the user's literal experience. The walk is the last mile.

```text
# DO — walked the literal user path, evidenced

Walked the /onboard flow end-to-end:
$ /onboard
Output:
  Welcome to multi-operator COC. Identity: jack-hong (unrostered).
  Posture: L2_SUPERVISED. Active claims (siblings): none.
  Next steps:
    /whoami --register   (you appear unrostered)
    /claim <path>        (when starting work on a path)
$ /whoami --register
Output:
  Drafted register proposal at .claude/.proposals/register-jack-hong.yaml
  PR will open at: <link>
User disposition: registered, next-step actionable, no confusion.
→ end-to-end walk confirmed.

# DO NOT — tests passed, declared done

- Implemented /onboard. Tier-2 tests pass. Reviewer approved. Done.
- The diff looks correct. Merging.
- CI green; shipping.
- I traced the code path mentally; it should work.
```

**BLOCKED rationalizations:**

- "The unit tests cover the user flow"
- "Integration tests are the user flow"
- "The reviewer agent confirmed it works"
- "The CI passed"
- "The lint / type-check passed"
- "The code is small enough that walking it would be redundant"
- "I traced the code path"
- "It compiled / it parses / it loaded"
- "The user can verify if it doesn't work"
- "I tested the underlying primitive; the user flow is composition"
- "The previous version of this command walked, so this version is fine"
- "Walking is overhead the test suite already pays"

**Why:** Unit + integration + Tier-3 tests verify the behavior of primitives in isolation; they DO NOT verify the user's composed path produces the user's expected outcome. A primitive that passes every test in isolation can still fail when composed with the rest of the user-facing flow (argument parsing, output rendering, session state assumptions, hook ordering, prompt-injection timing, error-message clarity, next-step legibility). Only the literal user walk catches these. A reviewer agent reviewing the diff is reviewing the diff, not invoking the deliverable as a user. CI is running the test suite the author wrote, not invoking the user's path.

### 2. Receipts For The Walk Are Mandatory

The walk MUST produce a **receipt**: verbatim command + verbatim output + the inferred user disposition after seeing the output (proceed / blocked / confused). Receipts MUST be embedded in the deliverable's commit message OR PR description OR session notes. "Walked it, looks good" without a receipt is BLOCKED — the receipt is the only evidence the walk actually happened.

```text
# DO — receipt embedded in PR description

## User-flow walk receipts

`/onboard`:
$ /onboard
Output (verbatim):
  Welcome to multi-operator COC. Identity: jack-hong (unrostered).
  …
Disposition: registered identity surfaced; next-step `/whoami --register` clear.

`/claim packages/foo/src/bar.py`:
$ /claim packages/foo/src/bar.py
Output (verbatim):
  Adjacency: INDEPENDENT (no sibling claims overlap).
  Claim record appended to coordination-log.
  Lease: advisory (no override required).
Disposition: claim succeeded; safe to proceed with Edit.

# DO NOT — claim-of-walk without receipt

- Walked the /onboard flow; it works.
- Tested end-to-end. Looks good.
- Confirmed user path. Shipping.
```

**BLOCKED rationalizations:** "The walk happened, the receipt is overhead" / "Receipts inflate PR descriptions" / "Anyone reviewing the PR can re-walk it" / "Verbatim output is too verbose" / "The screenshot is fine instead of text" / "The walk was obvious, no receipt needed".

**Why:** "Walked it, looks good" is unfalsifiable — the next reader cannot verify the walk happened, what the output was, or whether the user disposition was correct. Receipts convert an institutional claim ("the walk happened") into institutional evidence (the verbatim output, time-stamped via the commit/PR). Receipts also enable the future detection mechanism (mechanical sweep for "done" / "complete" anchors without receipts within ±300 chars).

### 3. The Walk Distinguishes Failure Modes Tests Cannot

When a test passes BUT the walk surfaces a failure (wrong output rendering, confusing error message, broken next-step, missing context, broken UX), the **failure mode is what ships**, not the test. Fix the failure mode the walk surfaces; do NOT declare the deliverable done because "the test passed." A passing test next to a broken user walk is **institutional theatre**.

```text
# DO — walk surfaces failure; fix the failure mode

Tier-2 test asserts: `/whoami` exits 0 + prints identity.
Walk: $ /whoami
Output: "person:jack-hong verified:gh-jack disp:jack-hong role:owner posture:L5"
Disposition: confused — output is dense; user cannot find their role at a glance.

→ Fix UX: re-format output to multiline with labels. Test still asserts
  exit 0 + identity present. Walk re-run; disposition: clear.

# DO NOT — declare done because test passed despite broken walk

Tier-2 test asserts: `/whoami` exits 0 + prints identity.
Walk surfaced confusing output, but the test passed.
→ Declared done; user discovers the confusion on first invocation.
```

**Why:** Tests verify properties the test author thought to check. The user's walk catches properties the test author did NOT think to check — which is the entire reason the walk matters. Treating "test passed" as canonical when the walk surfaced a different failure mode is the originating failure mode this rule blocks.

### 4. Prose Deliverables (Rules, Commands, Skills) Have A Walk Too

For rule files, command files, skill files, and other prescriptive prose distributed to consumer repos, the walk is: the file loads under the actual CLI runtime; frontmatter parses; paths resolve; the rule's claims about its own behavior are verified by an end-to-end test run; the DO / DO NOT examples render in the actual CLI surface; the BLOCKED patterns the rule describes fire when matched against fixture scenarios.

```text
# DO — prose walk receipts

`.claude/rules/multi-operator-coordination.md`:
- Loaded under CC: frontmatter parsed clean (priority: 10, scope: path-scoped).
- Rule injected once per session (verified via session-start log).
- Fixture `audit-fixtures/multi-operator-coordination/dataflow-claim-violation.txt`
  exercised end-to-end through the reviewer pipeline: the fixture's BLOCKED
  pattern fired as expected (structural validation per
  `rules/probe-driven-verification.md` — NOT the reviewer's diff-review of
  the rule prose, which MUST-1's BLOCKED list excludes from "the walk").
- DO / DO NOT example block rendered without CLI-syntax warnings.

`.claude/commands/onboard.md`:
- Invoked: $ /onboard
- Output rendered as the command's prose claims (deterministic read-path,
  fixed section order, identity + posture + claims + team-memory + DECISIONs).
- Procedure delegation to `41-onboard` skill confirmed (skill loaded).

# DO NOT — prose declared done after authoring

- Wrote .claude/rules/foo.md. All sections present. Done.
- Authored the new command. Reviewer approved. Shipping.
```

**Why:** Rules and commands are deliverables the user invokes; "the file exists and the prose looks right" is not the user's experience. The user's experience is the rule firing at a real gate, the command rendering real output, the example matching the user's actual scenario. Prose-only deliverables are still subject to the walk.

### 5. The Walk Caps Every Deliverable

The walk is the LAST mile before "done" applies. A session that runs tests + dispatches reviewers + builds the artifact + drafts the PR + ... and then declares done WITHOUT the walk has failed the discipline regardless of how many gates were green. The walk caps the deliverable; declaring done before the walk is BLOCKED even when all prior gates are clean.

```text
# DO — walk caps the deliverable; the walk is the last gate

Workflow:
  1. Implement deliverable.
  2. Tests pass (Tier-1 / 2 / 3).
  3. Reviewer + security-reviewer approve.
  4. CI green.
  5. Build artifact.
  6. Draft PR.
  7. ← WALK THE USER FLOW HERE — verbatim receipt to PR description.
  8. Merge.

# DO NOT — walk omitted because prior gates were green

Workflow:
  1. Implement.
  2. Tests pass.
  3. Reviewer approves.
  4. CI green.
  5. Declared done; merging.
  (steps 6–8: no walk, no receipt.)
```

**Why:** Gates protect against the failure modes their authors thought of. The walk catches the failure modes nobody thought of. Skipping the walk because prior gates were green is the inversion of defense-in-depth — it makes the walk an optional courtesy instead of the institutional last mile.

### 6. Receipts MUST Be Scrubbed Before Embedding In Public-Surface Artifacts

Verbatim command + verbatim output receipts (per MUST-2) MUST be **scrubbed** before embedding in PR descriptions, commit messages, journal entries, session notes, or any other artifact that may sync to public surfaces or downstream consumer repos. The scrub obligation is the conjunction of two existing contracts:

1. **Secrets / credentials / PII** per `rules/security.md` § "No secrets in logs" + § "MUST NOT": API keys, tokens, passwords, connection strings carrying credentials, PII (emails, names tied to private accounts). Redact inline (`[REDACTED]`, `${TOKEN}`, `<email>`) — never embed verbatim.

2. **Downstream-context tokens** per `rules/upstream-issue-hygiene.md` MUST-2: consumer project names, internal paths outside the SDK import surface (`src/<consumer-app>/...`, `workspaces/<name>/...`), workspace identifiers, finding tags (`F-G1-HIGH`, `Sec-MED-3`, etc.), session timestamps tied to consumer work, "Origin: <consumer-app>" footers. Redact or genericize before embedding.

The receipt's evidential value is the **structural shape** of the output (sections present, errors absent, next-step legibility), NOT the raw bytes. A scrubbed receipt that preserves shape but redacts sensitive substrings IS a valid receipt; a verbatim-everything dump that surfaces secrets or downstream identifiers is BLOCKED.

```text
# DO — scrubbed receipt preserves shape, redacts secrets + downstream-context

$ /whoami
Output (scrubbed):
  Identity: <operator-display-id> (verified via key fingerprint)
  Posture: L5_DELEGATED
  Active claims: none
  GitHub login: <operator-gh-login>
Disposition: identity surfaced; next-step actionable.

# DO NOT — verbatim everything; ships secrets / consumer paths to PR description

$ /whoami
Output:
  Identity: jane.doe@acme-consumer.com (verified via key sk-prod-XXXXXX)
  Posture: L5_DELEGATED
  Workspace path: workspaces/acme-cust-engagement-q3/
  Recent claim: src/acme-internal/billing/credit-card.py
Disposition: ready to proceed.
```

**BLOCKED rationalizations:**

- "Scrubbing defeats the verbatim-output requirement of MUST-2"
- "The receipt is in the PR description; everyone reviewing it already has access"
- "The output didn't look sensitive to me"
- "It's just a workspace path / a user email"
- "Verbatim is the contract; scrub is a follow-up"
- "The session-notes are private to me — they won't sync"
- "We can edit the PR description later if a secret leaks"

**Why:** Receipts embedded in PR descriptions, commit bodies, and session notes enter loom's git history and propagate to 30+ downstream consumer repos via `/sync`. Once on the public record, redaction is partial (GitHub preserves edit history; downstream pulls already happened). The verbatim-output requirement of MUST-2 is satisfied by the receipt's **structural shape**; scrubbing specific sensitive substrings does not reduce the receipt's evidential value but does prevent the disclosure-class failure modes that `rules/upstream-issue-hygiene.md` MUST-2 + `rules/security.md` § "No secrets in logs" exist to block. Walk discipline (MUST-1+2+3+5) and scrub discipline (this rule) are stacked, not in conflict.

## MUST NOT

- Declare a deliverable "done" / "complete" / "shipped" / "landed" / "ready" without the walk

**Why:** This is the originating failure mode this rule blocks.

- Substitute "the reviewer agent approved" for the walk

**Why:** Review agents check the diff for known failure modes; they do not invoke the deliverable through the user's literal path.

- Substitute "the CI passed" for the walk

**Why:** CI runs the test suite the author wrote; it does not invoke the user-facing flow.

- Submit a PR description that says "tested" without verbatim command + output receipts

**Why:** "Tested" without receipt is unfalsifiable; receipts are the only evidence the walk happened.

- Walk a substitute path (a similar command, a previous version, a fixture) instead of the actual user-facing path

**Why:** Substitutes verify the substitute path, not the user's path; the failure modes the user will hit live on the actual path, not the substitute.

## Trust Posture Wiring

- **Severity:** halt-and-report at gate-review (reviewer at `/implement`; cc-architect at `/codify`; security-reviewer surfaces when the walked path is security-sensitive). Advisory at hook layer (lexical Stop-event detection of "done" / "complete" / "shipped" / "landed" anchors without verbatim receipts within ±300 chars — future enhancement).
- **Grace period:** 7 days from rule landing (2026-05-22 → 2026-05-29).
- **Cumulative posture impact:** none for single instance; 3× across 30 days cumulates per `trust-posture.md` MUST Rule 4.
- **Regression-within-grace:** same-class violation within 7 days = emergency downgrade L5 → L4 per `trust-posture.md` MUST Rule 4. Add `user_flow_walk_omitted` to the emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: user-flow-validation]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** semantic gate-level reviewer is load-bearing — reviewer agent at `/implement` confirms every "done" / "complete" / "shipped" claim in PR descriptions, session notes, and commit messages has accompanying verbatim user-flow receipts (verbatim command + verbatim output + user's inferred next-step disposition). Lexical hook-layer detection (`detectDoneWithoutReceipt` on Stop event) is anticipated as a future enhancement; per `hook-output-discipline.md` MUST-2, lexical signals carry `advisory` severity only — the load-bearing detection is the semantic gate-level review. Audit fixtures will be committed under `.claude/audit-fixtures/` (the `user-flow-validation/` subdir) to exercise the BLOCKED rationalization patterns + the clean-pass case (PR description with receipts).
- **Violation scope:** rule-corpus-wide; applies to every deliverable across every session, every operator, every project. No project-scoped carve-outs.
- **Origin:** journal/0134-DECISION-codify-user-flow-validation-rule-2026-05-22 (this rule's receipt).

## Distinct From / Cross-References

- **Extends:** `rules/testing.md` § "End-to-End Pipeline Regression Above Unit + Integration" — that rule mandates Tier-2+ regression tests for docs-exact pipelines; this rule mandates the LITERAL user walk on top of those tests. The two are stacked: tests prove the primitives' behaviors; the walk proves the user's experience.
- **Pairs with:** `rules/zero-tolerance.md` Rule 6 "Implement Fully" — Rule 6 bans half-implementations of the code path; this rule bans declaring fully-implemented work "done" without the user walk. Different failure modes, complementary defense.
- **Pairs with:** `rules/verify-resource-existence.md` MUST-2 — that rule mandates live-API existence checks against runtime for permission debugging; this rule mandates live-runtime user walks for declaring done. Both anchor at "no proxy for runtime evidence."
- **Pairs with:** `rules/recommendation-quality.md` MUST-3 (symmetric pros and cons) — both rules anchor at honesty: recommendation-quality forbids hiding cons; this rule forbids hiding un-walked deliverables behind passing tests.
- **Distinct from:** `rules/specs-authority.md` MUST Rule 5 (specs updated at first instance) — that rule keeps specs current with truth; this rule keeps deliverables walked before declared done. Different concerns.
- **Distinct from:** `rules/agents.md` § Quality Gates — that rule mandates gate-level reviewers at `/implement` and `/release`; reviewers are NOT a substitute for the walk per MUST-1 BLOCKED list.

## Origin

2026-05-22 — user directive during F14 M8 Shard F Wave 2 (mid-flight; F-2 still running). Verbatim co-owner directive (journal/0134 receipt):

> "please codify this: i want you to /codify this, NEVER EVER again give me something that has NOT been FULLY TESTED. by fully tested, it means to go through what a human user will need to and ensure it works"

Rule originates at loom (the COC artifact splitter) under `artifact-flow.md` § Co-Owner-Directed Origination — verbatim directive + receipt-first journal DECISION (0134) + COC-tooling scope (a baseline COC rule). Distributes to 30+ downstream consumer repos via `/sync`.

Companion auto-memory at `~/.claude/.../memory/feedback_user_flow_validation.md` ensures every future session inherits the discipline regardless of rule-corpus loading state.

**Length rationale (per `rules/rule-authoring.md` MUST NOT length cap).** This rule body is ~280 lines, exceeding the 200-line guidance. Named rationale: **walk-discipline + scrub-discipline are intrinsically linked**. MUST-1 through MUST-5 codify the walk (when, how, what receipts); MUST-6 codifies the scrub conjunction (`upstream-issue-hygiene.md` MUST-2 + `security.md` § "No secrets in logs") that gates the receipt from public-surface artifacts. The two halves are non-separable — splitting "walk" and "scrub" into sibling rules would let a future session honor walk-MUST-1 while violating scrub-MUST-6 on the same artifact, exactly the failure mode the rule's load-bearing closure prevents. Per `rules/rule-authoring.md` MUST NOT § "Rules longer than 200 lines": the cap is guidance; overage is permitted with named rationale anchored at the rule's Origin. Sibling precedent: `multi-operator-coordination.md` § Origin carries the same length-rationale shape for the same class of multi-clause structural rule.
