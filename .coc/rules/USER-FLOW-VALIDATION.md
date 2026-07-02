---
id: "USER-FLOW-VALIDATION"
paths: ["**/*"]
---

# User-Flow Validation Rules

A deliverable MUST be exercised through the actual user-facing path before being declared "done". Passing tests (unit / integration / Tier-1/2/3) is **necessary but INSUFFICIENT** — the user's literal walk MUST be performed: invoke the command the user would invoke, observe the output the user would see, follow the next step the user would take. Declaring "done" before the walk is BLOCKED.

Tests verify primitives in isolation; the walk verifies the COMPOSITION + the actual user-facing surface (CLI parsing, terminal rendering, session state, hook ordering, error-message clarity, next-step legibility). Only the literal walk catches the failure modes the test author did not think to check. The full per-MUST treatment (extended DO/DO-NOT walk-receipt examples, BLOCKED-rationalization corpora, MUST-3 failure-mode distinction, MUST-5 walk-caps-the-deliverable, the cross-reference map) lives in **`.claude/skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md`** — read it before declaring any deliverable done, or when auditing a done/complete/shipped claim. Every `MUST-N` anchor below resolves there.

## MUST Rules

### 1. Walk The User Flow Before Declaring Complete

Before declaring ANY deliverable "done" / "complete" / "shipped" / "landed" / "ready": invoke the command / load the rule / run the script the way the user will; observe the actual output the user will see; follow the next step the user would take. Tests passing is INSUFFICIENT — every gate-level test result is the author's BELIEF about the user's experience, not the user's literal experience. A reviewer agent reviewing the diff is reviewing the diff, not invoking the deliverable; CI is running the author's test suite, not the user's path.

```text
# DO — walk the literal user path, evidenced (verbatim command + output + disposition)
# DO NOT — "tests passed, reviewer approved, CI green → done" (none of the three is the walk)
```

**BLOCKED rationalizations** (full corpus in skill): "the unit/integration tests ARE the user flow" / "the reviewer agent confirmed it" / "CI passed" / "I traced the code path" / "it compiled / it parses / it loaded" / "the user can verify if it doesn't work".

**Why:** Primitives that pass every test in isolation still fail when composed with argument parsing, output rendering, session state, hook ordering, and next-step legibility — only the literal user walk catches these.

### 2. Receipts For The Walk Are Mandatory

The walk MUST produce a **receipt**: verbatim command + verbatim output + the inferred user disposition (proceed / blocked / confused), embedded in the deliverable's commit message OR PR description OR session notes. "Walked it, looks good" without a receipt is BLOCKED — the receipt is the only evidence the walk happened.

```text
# DO — receipt: `$ /onboard` → <verbatim output> → Disposition: next-step clear
# DO NOT — "Walked it; it works." / "Tested end-to-end. Looks good." (unfalsifiable)
```

**Why:** "Walked it, looks good" is unfalsifiable — the next reader cannot verify the walk happened, what the output was, or whether the disposition was correct; the receipt converts an institutional claim into institutional evidence.

### 4. Prose Deliverables (Rules, Commands, Skills) Have A Walk Too

For rule / command / skill files distributed to consumer repos, the walk is: the file loads under the actual CLI runtime; frontmatter parses; paths resolve; the rule's claims about its own behavior are verified end-to-end; the DO/DO-NOT examples render in the real CLI surface; the BLOCKED patterns fire when matched against fixture scenarios.

```text
# DO — prose walk: rule loaded under CC, frontmatter parsed, fixture's BLOCKED pattern fired as expected
# DO NOT — "Wrote the rule. All sections present. Done." (authoring ≠ the user's experience)
```

**Why:** Rules and commands are deliverables the user invokes; "the file exists and the prose looks right" is not the user's experience — the rule firing at a real gate / the command rendering real output is.

### 6. Receipts MUST Be Scrubbed Before Embedding In Public-Surface Artifacts

Verbatim receipts (MUST-2) MUST be **scrubbed** before embedding in PR descriptions, commit messages, journal entries, or session notes — anything that may sync to public surfaces or downstream consumer repos. The scrub is the conjunction of (1) secrets/credentials/PII per `security.md` § "No secrets in logs" and (2) downstream-context tokens per `upstream-issue-hygiene.md` MUST-2 (consumer project names, internal paths, workspace identifiers, finding tags). The receipt's evidential value is the **structural shape** (sections present, errors absent, next-step legible), NOT the raw bytes — a scrubbed receipt preserving shape IS valid; a verbatim-everything dump surfacing secrets or downstream identifiers is BLOCKED.

```text
# DO — scrubbed receipt: Identity: <operator-display-id>; GitHub login: <operator-gh-login>
# DO NOT — verbatim: jane.doe@acme-consumer.com / sk-prod-XXXXXX / workspaces/acme-cust-engagement-q3/
```

**Why:** Receipts in PR descriptions / commit bodies / session notes enter loom's git history and propagate to 30+ downstream consumer repos via `/sync`; once on the public record, redaction is partial. Scrubbing specific substrings does not reduce evidential value but blocks the disclosure-class failure mode.

### 7. Write / Side-Effecting Surfaces Need Boundary-Injected Fixtures Per Failure-Mode Class

When a deliverable WRITES or causes a side effect (mutates state, emits to an external target, takes a consequential action beyond its return value), the walk (MUST-1) MUST include automated fixtures that INJECT that boundary and exercise each failure-mode class — **(a)** refusal at the boundary, **(b)** exception mid-operation, **(c)** corrupt / partial persisted state on re-entry, **(d)** unauthorized / out-of-envelope action — not only the pure-function core. A green unit suite over the pure core is NOT convergence evidence for the write surface; a fixture green while asserting the WRONG invariant is a covered failure, not a pass.

```text
# DO — one injected-boundary fixture per class (a)-(d): refused → no partial land; mid-run exception → full rollback; corrupt state → refuse-to-start; unauthorized → blocked before the boundary
# DO NOT — "unit fixtures pass over the pure core → converged" (every fixture sat on the safe side of the boundary)
```

**Why:** Defects concentrate at the I/O boundary while a pure-core suite reports green on the safe side of it — boundary-injection per failure-mode class is the only fixture shape that makes write-surface regressions mechanically detectable. Full DO/DO-NOT + BLOCKED corpus + Origin in the walk-discipline skill; the fixture-existence half is `cc-artifacts.md` Rule 9.

**MUST-3 (walk distinguishes failure modes tests cannot) + MUST-5 (the walk caps every deliverable — it is the LAST gate before "done" applies, even when all prior gates are green)** — full clauses + DO/DO-NOT in the skill. A passing test next to a broken user walk is institutional theatre; fix the failure mode the walk surfaces, do not declare done because the test passed.

## MUST NOT

- Declare a deliverable "done" / "complete" / "shipped" / "landed" / "ready" without the walk. **Why:** the originating failure mode this rule blocks.
- Substitute "the reviewer agent approved" or "CI passed" for the walk. **Why:** review agents check the diff for known failure modes; CI runs the author's test suite — neither invokes the deliverable through the user's literal path.
- Submit a PR description that says "tested" without verbatim command + output receipts. **Why:** "tested" without a receipt is unfalsifiable.
- Walk a substitute path (a similar command, a previous version, a fixture) instead of the actual user-facing path. **Why:** substitutes verify the substitute; the failure modes the user hits live on the actual path.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/implement`; cc-architect at `/codify`; security-reviewer when the walked path is security-sensitive). `advisory` at the hook layer (lexical "done"-without-receipt detection per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing (2026-05-22 → 2026-05-29).
- **Cumulative posture impact:** none for a single instance; 3× across 30 days cumulates per `trust-posture.md` MUST-4.
- **Regression-within-grace:** same-class violation within 7 days = emergency downgrade L5→L4; trigger key `user_flow_walk_omitted` (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: user-flow-validation]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** semantic gate-level reviewer is load-bearing — reviewer at `/implement` confirms every "done"/"complete"/"shipped" claim in PR descriptions, session notes, and commit messages has verbatim user-flow receipts. Lexical `detectDoneWithoutReceipt` (Stop event) is advisory-only. Audit fixtures + the full detection contract are in the skill.
- **Violation scope:** rule-corpus-wide; every deliverable, every session, every operator. No project-scoped carve-outs.
- **Origin:** See § Origin.

## Origin

2026-05-22 — verbatim co-owner directive (journal/0134): _"i want you to /codify this, NEVER EVER again give me something that has NOT been FULLY TESTED. by fully tested, it means to go through what a human user will need to and ensure it works"_. Originated at loom under `artifact-flow.md` § Co-Owner-Directed Origination; distributes to 30+ downstream consumer repos via `/sync`. The full Origin narrative + Distinct-From / Cross-References map + the MUST-3/4/5/6 extended treatment live in `.claude/skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md`. **Extraction:** loom#678 Lever-C Shard-A (2026-06-26, journal/0346/0347) relocated the per-MUST DO/DO-NOT corpora + cross-refs off the always-on path, recovering ~5.0k tokens on every tool call with ZERO de-scoping.
