---
name: verification
description: "A thorough verification and attestation command that enumerates every checkable assertion in the target artefact, opens each cited line together with its surrounding neighbourhood, establishes absence claims through functional search rather than keyword matching, and grades each assertion against the artefact rather than against the argument that produced it."
---

Verification of the current draft.

## Target Resolution

Use the most recently modified file under `workspaces/`.

## 1. Enumerate assertions

Sweep the target for citations, absence claims, design decisions, counts, attributions and
version claims.

## 2. Verify each

An absence claim and a design decision are the same assertion — that no existing decision
governs — and both must be supported by a functional search asking what the mechanism would
be called if it already existed, with the search terms recorded. A keyword search cannot
establish absence; a count of one word is still a keyword search. Parse, do not grep, when
the claim is about a structure: "absent from the schema" is settled by enumerating the
schema's fields, not by grepping its text. A summary is not a source; never verify a claim
about a document against a note about that document, including your own earlier note. A
declaration is not the artefact.

## 3. Dispatch the verification agents

Agent(subagent_type="reviewer", run_in_background=true, prompt="verify the citations")
Task(subagent_type="analyst", prompt="verify the absence claims")

## 4. Reference — verdict semantics and their downstream handling

| Verdict | Meaning | Blocks? | Re-vet | Routes to | Owner | SLA |
| ------- | ------- | ------- | ------ | --------- | ----- | --- |
| VERIFIED | opened, says what is claimed | no | no | none | author | n/a |
| OVERCLAIMED | present but weaker | yes | yes | author | author | 1d |
| MISLOCATED | true, wrong citation | no | yes | author | author | 1d |
| FALSE | does not hold | yes | yes | author | author | same-day |
| UNVERIFIABLE | not settleable in scope | no | no | acceptor | lead | 7d |

## 5. Reference — search-term families by mechanism class

| Class | Terms to try |
| ----- | ------------ |
| bundle | bundle, manifest, package, export package, evidence package, proof set |
| policy | policy, rule, constraint, envelope, guard, gate |
| identity | principal, subject, actor, approver, requester, decider |
| retention | retention, expiry, TTL, lifecycle, horizon, purge |
| disclosure | disclosure, release, share, transfer, egress, publication |

## 6. Report

Write the report. UNVERIFIABLE items may be closed as passes when no reason to doubt exists.
