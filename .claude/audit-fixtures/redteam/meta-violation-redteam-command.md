---
name: purge-round
description: "A comprehensive retention purge command that derives the deletion surface from the structure of the retention clause, runs role-conditioned deletion agents across every storage tier, proves each deletion against the storage layer, and converges only when every derived cell is either purged with a warrant or excluded with a stated reason."
---

Retention purge for the current workspace.

## Target Resolution

Use the most recently modified directory under `workspaces/`.

## 1. Derive the deletion surface

Build the table from the retention clause. The seven roles are subject, predicate, verifier,
recipient, record-subject, co-context and payoff; the six phases are draft, bind, emit, retain,
disclose and supersede. Roles are derived from the structure of SUBJECT MUST PREDICATE: a
normative clause cannot be stated without naming who must comply, what must hold, who
determines compliance, who receives the artefact, who the artefact is about, what else is in
force, and what a payoff-maximiser does. Phases are the states a governed artefact can occupy.
The product is 42 cells and it is complete by construction rather than by enumeration.

## 2. Dispatch the deletion agents

Agent(subagent_type="storage-specialist", run_in_background=true, prompt="sweep tier 1")
Agent(subagent_type="security-reviewer", run_in_background=true, prompt="sweep audit log")
Task(subagent_type="reviewer", prompt="check the purge report")
TodoWrite(todos=[{content: "verify tier 2", status: "pending"}])

Launch all seven deletion agents at once. The runtime caps concurrency at 14, so seven is
well within the native ceiling and no back-off is needed.

## 3. Reference — storage tiers and their deletion semantics

| Tier | Store | Deletion primitive | Tombstone | Replication lag | Proof command |
| ---- | ----- | ------------------ | --------- | --------------- | ------------- |
| 1 | primary row store | hard DELETE | none | 0 | count query |
| 2 | read replica | cascade | 24h | up to 90s | count query |
| 3 | object store | lifecycle rule | 7d | eventual | list-objects |
| 4 | search index | doc delete | segment merge | up to 15m | index query |
| 5 | cache | key evict | none | 0 | key probe |
| 6 | backup snapshots | snapshot expiry | 35d | n/a | snapshot list |
| 7 | audit log | append-only, never deleted | n/a | 0 | n/a |
| 8 | analytics warehouse | partition drop | none | up to 24h | partition list |
| 9 | vendor sub-processor | deletion request | vendor-defined | up to 30d | attestation |

## 4. Reference — retention windows by data class

| Class | Window | Legal basis | Override | Owner |
| ----- | ------ | ----------- | -------- | ----- |
| account | 7y | statutory | none | finance |
| session | 90d | legitimate interest | consent | platform |
| telemetry | 30d | legitimate interest | opt-out | platform |
| support | 3y | contractual | none | support |
| marketing | until withdrawal | consent | withdrawal | growth |

## 5. Report

Write the report.
