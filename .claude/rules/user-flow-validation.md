---
name: user-flow-validation
description: Walk the actual user-facing flow before declaring any deliverable done. Tests passing is necessary but NOT sufficient. Receipts (verbatim command + verbatim output + user's next-step disposition) are mandatory and MUST be scrubbed before any public-surface embedding. Full DO/DO-NOT corpora + per-MUST detail in the paired skill.
priority: 10
scope: path-scoped
paths:
  # loom#678 Lever B: anchored from the unanchored `**/*` to the surfaces this rule
  # genuinely governs. MUST-1 walks a DELIVERABLE; MUST-4 names prose deliverables
  # (rules, commands, skills). In a workspace the deliverable is not the workspace
  # file but the artifact it plans, so the walk fires when THAT artifact is touched.
  # Both anchored and nested forms are listed: consumer layouts nest these roots.
  - ".claude/**"
  - "**/.claude/**"
  - "specs/**"
  - "**/specs/**"
  - "briefs/**"
  - "**/briefs/**"
  - "todos/**"
  - "**/todos/**"
  - "**/.session-notes*"
  - "src/**"
  - "**/src/**"
  - "packages/**"
  - "crates/**"
  - "tests/**"
  - "**/tests/**"
  - "scripts/**"
  - "tools/**"
---

# User-Flow Validation Rules

A deliverable MUST be exercised through the actual user-facing path before being declared "done". Passing tests (unit / integration / Tier-1/2/3) is **necessary but INSUFFICIENT** — the user's literal walk MUST be performed: invoke the command the user would invoke, observe the output the user would see, follow the next step the user would take. Declaring "done" before the walk is BLOCKED.

Full per-MUST depth (extended DO/DO-NOT receipts, the complete BLOCKED corpora, MUST-3/5, MUST-8's worked release-gate example): **`.claude/skills/30-claude-code-patterns/user-flow-validation-walk-discipline.md`**, where every `MUST-N` anchor below resolves. Read it before declaring any deliverable done.

## MUST Rules

### 1. Walk The User Flow Before Declaring Complete

Before declaring ANY deliverable "done" / "complete" / "shipped" / "landed" / "ready": invoke the command / load the rule / run the script the way the user will; observe the actual output the user will see; follow the next step the user would take. Tests passing is INSUFFICIENT — every gate-level test result is the author's BELIEF about the user's experience, not the user's literal experience.

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

### 8. A Release / Verification Gate Drives The Un-Pre-Configured Real-Consumer Path

When a gate VERIFIES a deliverable by DRIVING it — a release FIRST-ACT gate, an install-and-invoke check, an integration walk — the walk MUST drive the path a REAL, UN-PRE-CONFIGURED consumer hits: the consumer arrives WITHOUT the system pre-seeded into the happy state. A gate that manually seeds the config / keys / fixtures / JWKS the real consumer supplies at runtime, drives only that happy path, and reports PASS is walking a SUBSTITUTE path (the MUST NOT "Walk a substitute path" mode), NOT the literal user path. The gate MUST additionally drive **(a)** the un-pre-configured COLD entry, **(b)** the real provider / format / dialect VARIANTS the consumer uses, **(c)** the ERROR / boundary paths (MUST-7's failure-mode classes). Declaring the deliverable verified on a pre-configured happy walk alone is BLOCKED.

```text
# DO — install the published artifact, do NOT pre-seed the consumer's runtime state, drive
#      cold-entry + a real RS256 provider + the boundary paths → receipt
# DO NOT — pre-seed the exact config the callback needs, drive good-vs-bad state, report PASS
#      (a real un-seeded consumer then hits every defect that walk sat on the safe side of)
```

**BLOCKED rationalizations** (full corpus in skill §8): "the gate installed the real artifact, so it's a real walk" / "seeding the config is just test setup" / "the happy path IS the user path" / "the consumer's provider is the same as my fixture" / "the error paths are MUST-7's job, not this gate's" / "a pre-configured pass IS a pass".

**Why:** A gate that seeds the exact runtime state the real consumer supplies drives a path no consumer ever walks — the pre-configured happy walk sits on the safe side of every defect a cold, real-provider consumer hits. The literal user arrives un-seeded; only the un-pre-configured walk crosses the boundary where the consumer-facing defects live.

## MUST NOT

- Declare a deliverable "done" / "complete" / "shipped" / "landed" / "ready" without the walk. **Why:** the originating failure mode this rule blocks.
- Substitute "the reviewer agent approved" or "CI passed" for the walk. **Why:** review agents check the diff for known failure modes; CI runs the author's test suite — neither invokes the deliverable through the user's literal path.
- Submit a PR description that says "tested" without verbatim command + output receipts. **Why:** "tested" without a receipt is unfalsifiable.
- Walk a substitute path (a similar command, a previous version, a fixture) instead of the actual user-facing path. **Why:** substitutes verify the substitute; the failure modes the user hits live on the actual path.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/user-flow-validation.md`, which every validator reads as part of this rule.
