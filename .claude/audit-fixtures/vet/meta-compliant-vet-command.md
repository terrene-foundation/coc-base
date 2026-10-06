---
name: attest
description: "Attestation pass. Open every cited control, test each coverage claim, grade against the evidence."
argument-hint: "[path, workspace, or \"claim\"]"
---

Attestation of **$ARGUMENTS**. Governed by `rules/evidence-first-claims.md` and `rules/instrument-discipline.md` — read them; this command is their operating procedure, not a restatement.

## Target Resolution

1. If `$ARGUMENTS` is a path, attest that file
2. If it names a workspace, attest its most recently modified control matrix
3. If it is a quoted claim, attest that claim alone
4. Empty → the most recently modified file under `workspaces/*/03-drafts/`

## 1. Enumerate every attestable control

Sweep the target and list every control claim BEFORE testing any of them; the enumeration is what makes coverage auditable. Kinds: control citation, coverage claim, count, attribution, operating-effectiveness claim.

## 2. Test each — against the control, never against its description

- Open the cited control and its neighbourhood; the sentence retrieved is routinely not the whole control.
- Name the falsifying result before citing any test as evidence, and fire the test at a known-answer case first so it is shown to discriminate here.
- Read the hits, not the tally — and check what a count counts.

## 3. Grade

Verdicts: **EFFECTIVE**, **PARTIAL**, **MISLOCATED**, **INEFFECTIVE**, **UNTESTABLE**. UNTESTABLE is a finding, not a pass; where the blocker is a scope boundary, record the boundary rather than inventing a workaround.

## 4. Report

Write `workspaces/<project>/04-validate/NN-attest-<slug>.md` with counts per verdict, the blocking section first, and the falsifying result recorded for every test cited.

## 5. Fix, then re-attest

Repair on discovery, sweep siblings, and re-run until 0 INEFFECTIVE and 0 PARTIAL.

## Journal (MUST — phase-complete gate)

Create **RISK** for an ineffective control that was load-bearing and **GAP** for one nothing reachable can test. Use `/journal new <TYPE> <slug>`; check the highest `NNNN-` and increment.
