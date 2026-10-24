---
priority: 10
scope: path-scoped
paths:
  # Split from recommendation-quality.md (context-budget 2026-10-10). Loads ONLY where its MUSTs bind:
  # MUST-7 where an autonomous pick is executed (/autonomize); MUST-8 where handled content is
  # persisted to a durable surface (journal, team-memory, shared session notes) or to a synced /
  # global one (artifacts, proposals, workspaces, specs, docs, READMEs).
  - ".claude/{rules,skills,agents,commands,guides}/**"
  - ".claude/.proposals/**"
  - "workspaces/**"
  - "todos/**"
  - "specs/**"
  - "docs/**"
  - "**/README.md"
  - "journal/**"
  - ".claude/team-memory/**"
  - "**/.session-notes.d/**"
  - "**/.session-notes.shared.md"
---

# Recommendation Quality — Escalation For Ratification (MUST-7, MUST-8)

## MUST Rules

### 7. A Below-Confidence Recommendation Escalates For Ratification, Regardless Of Blast-Radius

When the agent produces a recommendation it **cannot stand behind on evidence** — a pick it judges LOW-confidence (thin or absent evidence, an unfamiliar domain, a pattern-match dressed as a verified convention, a guess) — the disposition MUST be to **ESCALATE**: surface the recommendation, state the confidence explicitly, name the specific evidence that would raise it, and request the user's **ratification** BEFORE acting. This holds **regardless of how low the action's blast-radius is** — a cheap, easily-reversible, decidable ("clear") pick held at low confidence is escalated, NOT auto-executed. Auto-executing a below-confidence pick because "it is cheap and there IS a pick" is BLOCKED.

**Confidence is a third axis, orthogonal to blast-radius (`/autonomize` § Prudence) and undecidability (MUST-1); decidability ≠ confidence.** Axis exposition: the extract § "Why confidence (MUST-7) is a THIRD axis".

**Escalation is NOT a menu-punt — MUST-1 still binds.** The agent STILL produces the single recommendation with implications and symmetric pros/cons (MUST-1/2/3); MUST-7 adds one thing — the low-confidence pick is surfaced for ratification (a yes/no or single decision point per MUST-5) instead of auto-executed. The confidence label is part of the recommendation's quality, not a subtraction from it (per MUST-3's symmetric-honesty principle).

**BLOCKED rationalizations** (full corpus in the guide extract § MUST-7): "There's a clear pick, so `/autonomize` says proceed" / "It's cheap / easily reversible, low blast-radius" / "Asking would be hedging" / "I made a pick, that satisfies MUST-1" / "The redteam / next session will catch it if it's wrong" / "Stating low confidence undermines the recommendation".

### 8. A Sensitivity/Classification Escalation Escalates For Confirmation, Regardless Of Blast-Radius

When an autonomous action would raise the **sensitivity or audience** of handled content — incorporating HIGHER-sensitivity material into a LOWER-sensitivity or WIDER-audience **durable** surface — the disposition MUST be to **CONFIRM before persisting**: name the sensitivity partition being crossed, state the lower-exposure alternative that exists, and request the user's confirmation. This holds **even when the write is mechanically cheap** — not destructive, not hard-to-reverse, not externally-visible-yet (a purely-local commit) — i.e. when it trips none of the action-type gates `/autonomize` § Prudence enumerates. Auto-persisting a sensitivity escalation because "the write is cheap and in-scope" is BLOCKED.

**The partitions** (illustrative, not exhaustive — the AGENT judges sensitivity qualitatively, NO hardcoded classification table, per `rules/agent-reasoning.md`): secret / credential / PII → a durable artifact (commit body, journal, doc); **gitignored-per-operator** material (`loom-links.local.json`, private config, a sibling's local state) → a **committed shared** artifact (team-memory, shared session notes, a journal entry); **tenant-scoped** content → a **global or synced** artifact.

**Sensitivity is a fourth escalation dimension the other three gates miss:** blast-radius, undecidability and confidence all ask about the ACTION; sensitivity asks whether the write raises the EXPOSURE / classification of the content. MUST-8 is that gate. Axis exposition (incl. why the one authoring-time disclosure hook is dormant on canon): the extract § "Why sensitivity (MUST-8) is a FOURTH axis the other three gates miss".

**Escalation is NOT a menu-punt — MUST-1 still binds.** The agent STILL recommends the write it believes is correct (or its scrubbed / lower-exposure form); MUST-8 adds one thing — the sensitivity-crossing write is surfaced for confirmation (a yes/no or single decision point per MUST-5) instead of auto-persisted.

**BLOCKED rationalizations** (full corpus in the guide extract § MUST-8): "It's a local commit, not a push — no one sees it yet" / "The disclosure scrub / Gate-2 will catch it" / "It's cheap / easily reversible, low blast-radius" / "The content came from a file I was authorized to read" / "I'll just scrub it myself, no need to confirm" / "security.md already covers secrets".

## MUST NOT

- Auto-execute a recommendation held below the agent's confidence floor without escalating it for ratification, even on a low-blast-radius action

**Why:** Confidence is orthogonal to blast-radius; a low-confidence pick that passes the blast-radius (Prudence) and undecidability (MUST-1) gates ships a silent guess the user never got to ratify — the exact quadrant MUST-7 exists to catch.

- Auto-persist a write that raises the sensitivity or audience of handled content — a secret into a durable artifact, gitignored-per-operator material into a committed shared surface, tenant-scoped content into a global/synced one — without surfacing the partition for confirmation, even on a low-blast-radius local write

**Why:** Sensitivity is a distinct axis from all three existing gates (Prudence's action-mechanics proxy, MUST-7 confidence, MUST-1 undecidability); a mechanically-cheap sensitivity-elevating write passes all three, and no distribution fence re-examines an already-committed in-repo write — the authoring verdict is the only point the escalation can be caught.

Depth — the extract (cited above as **the extract** and **the guide extract**: MUST-7/MUST-8 examples, axis expositions and full rationalization corpora) — lives in `.claude/guides/rule-extracts/recommendation-quality.md`.

Probes: `.claude/test-harness/probes/recommendation-quality-escalation.probes.json` (fixtures `.claude/audit-fixtures/recommendation-quality/`).

Depth — the Trust-Posture Wiring and the full Why paragraphs — lives in `.claude/skills/32-trust-posture/wiring/recommendation-quality-escalation.md`, which every validator reads as part of this rule.

Pointer — MUST-1, MUST-2 and MUST-3, cited above, are clauses 1–3 of `recommendation-quality.md`, a part that does not load on every path this one does.
