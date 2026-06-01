---
priority: 10
scope: path-scoped
paths:
  - "journal/**"
  - "**/journal/**"
---

# Journal Author Discipline — Verifiable, Not Trusted

A journal entry's `author:` frontmatter field (`human` | `agent` | `co-authored` per `rules/journal.md`) is a CLAIM about who originated the decision. Under the F101 governance-as-DNA capture stream (loom#411), that claim is no longer taken on trust: every session records a per-session provenance ledger (`.claude/learning/provenance/<session>.jsonl`) carrying a `HumanInput` event for each genuine human turn. A `human` / `co-authored` author claim is VERIFIABLE against that ledger — and an unverifiable claim is flagged, not silently accepted.

This rule binds the `author:` field to the ledger. The procedure (decision-tree, ledger signature per label, secrets fence, halt-and-report runbook) lives in the depth-file `.claude/skills/30-claude-code-patterns/decision-recording-discipline.md`; the rule body stays skim-readable.

## MUST Rules

### 1. `author:human|co-authored` Is Valid ONLY When Backed By A Session HumanInput Event

A journal entry whose frontmatter declares `author: human` or `author: co-authored` MUST be backed by ≥1 `HumanInput` event in the LIVE per-session provenance ledger. An author claim with zero backing HumanInput events MUST be flagged UNBACKED — author claims are **verifiable, not trusted**. Treating the frontmatter assertion as self-justifying is BLOCKED.

```text
# DO — the human|co-authored claim matches the live ledger
author: human         # session ledger carries ≥1 kind:"HumanInput" event → BACKED

# DO NOT — accept the claim because the frontmatter says so
author: human         # session ledger carries 0 HumanInput events → UNBACKED,
                      # but shipped anyway "because the field says human"
```

**Why:** A human-authored decision carries more institutional weight than an agent-surfaced one; an unverified `author: human` lets an agent-originated decision masquerade as human-anchored, corrupting every downstream judgment that weights provenance. The ledger is the only evidence the human actually drove the decision — the field is the claim, the ledger is the proof.

### 2. Agent-Surfaced Entries Render "n/a — agent-surfaced", Never "BACKED by human input"

An entry whose frontmatter declares `author: agent` makes NO human-input claim. Its backing status MUST render the cosmetic label `n/a — agent-surfaced`. Labelling an agent-surfaced entry "BACKED by human input" (or running the human-backing check against it) is BLOCKED.

```text
# DO — agent author renders the n/a label; no ledger check performed
author: agent         # backing status: "n/a — agent-surfaced"

# DO NOT — claim human backing for an agent-surfaced entry
author: agent         # rendered as "BACKED by human input" — a category error;
                      # the entry never claimed human authorship
```

**Why:** Conflating "agent-surfaced" with "human-backed" inflates the provenance weight of agent-originated decisions — the exact mis-attribution the verifiability layer exists to prevent. The `n/a` label is honest: there is no human claim to verify, so there is no backing to assert.

### 3. The Check Reads The LIVE Per-Session Ledger — Not Frontmatter, Notes, Or Memory; Missing Ledger Halts, Never Silently Passes

The author-backing check MUST read the live per-session provenance ledger resolved via `provenance-ledger.js::_ledgerPath(repoDir, session)`. It MUST NOT substitute the frontmatter's own assertion, `.session-notes`, auto-memory, or any other proxy for the ledger. When the ledger is absent or unreadable, the status is `undetermined` and the disposition is **halt-and-report** — a missing ledger MUST NOT silently pass as backed.

```text
# DO — resolve + read the live ledger; absent ledger → halt-and-report
status = checkAuthorBacking({repoDir, session, frontmatterAuthor})  # reads the .jsonl
# ledger absent → status "undetermined" → halt-and-report (degraded capture is ambiguous)

# DO NOT — trust a proxy, or silently pass when the ledger is missing
# "the frontmatter says human, that's the source of truth" → BLOCKED
# "no ledger found, assume backed and proceed" → BLOCKED (silent pass)
```

**Why:** A proxy (frontmatter / notes / memory) describes INTENT, never CURRENT runtime state — the same hearsay-vs-evidence failure `rules/verify-resource-existence.md` MUST-2 blocks. Silently passing on a missing ledger converts "we cannot verify" into "verified", which is exactly the false-positive the rule exists to prevent; halt-and-report surfaces the ambiguity (degraded capture vs false claim) for the user to adjudicate.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at the hook layer (the F101-3 author-backing branch in `.claude/hooks/journal-write-guard.js` is REGISTRY-class — it reads a ledger file + matches frontmatter, NOT an irrefutable structural signal; per `hook-output-discipline.md` MUST-2 it MUST NOT carry `block`, which is reserved for the same hook's `fs.existsSync` file-exists branch). `halt-and-report` also at gate-review (`/codify` sweep over journal entries).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (shipping a journal entry whose `author:human|co-authored` claim is UNBACKED against the live ledger) contribute to `rules/trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days of landing triggers emergency downgrade L5→L4 per `rules/trust-posture.md` MUST Rule 4. Trigger key `unbacked_author_claim` added to that rule's emergency-trigger list (1× = drop 1 posture).
- **Receipt requirement:** SessionStart MUST require `[ack: journal-author-discipline]` in the agent's first response IF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** the F101-3 author-backing branch in `.claude/hooks/journal-write-guard.js` (calling `.claude/hooks/lib/provenance-author-backing.js::checkAuthorBacking`) fires at PreToolUse(Write) on a new journal entry — emits `halt-and-report` for `unbacked`/`undetermined`, passthrough for `backed`/`n/a-agent`. Paired `/codify` sweep: cc-architect greps new journal entries for `author:human|co-authored` and confirms each is backed against the session ledger. Audit fixtures at `.claude/audit-fixtures/journal-author-discipline/` (one per `checkAuthorBacking` status). Unit tests at `.claude/test-harness/tests/provenance-author-backing.test.mjs`.
- **Violation scope:** MUST-1 (unbacked human|co-authored claim) + MUST-2 (agent-surfaced mislabelled as backed) fire the Wiring; MUST-3 (live-ledger read + halt-on-missing) is the structural-NULL discipline the hook enforces.
- **Origin:** See § Origin below.

## Origin

F101-3 (loom#411 governance-as-DNA, loom lane) — journal/0192 §Deferred + #411 item 2. Builds on F101-1 (the canonical provenance-event schema, journal/0190) + F101-2 (the per-session capture hooks, journal/0188 §D). The author-backing check is the VERIFIABILITY layer atop the capture stream: F101-2 records `HumanInput` events deterministically; F101-3 reads them to verify that a `human`/`co-authored` author claim is real. Co-owner-directed origination per `rules/artifact-flow.md` § Co-Owner-Directed Origination (receipt-first F101 chain).
