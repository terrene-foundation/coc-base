---
id: "VET"
name: vet
description: "Verification pass. Open every citation, functionally test every absence claim, grade against artefact not argument."
argument-hint: "[path, workspace, or \"claim\"]"
---

Verification of **$ARGUMENTS**. Governed by `rules/adversarial-coverage.md` MUST-4 + MUST-6, `rules/evidence-first-claims.md`, `rules/instrument-discipline.md`, and `rules/verify-resource-existence.md` — read them; this command is their operating procedure, not a restatement.

**`/redteam` asks what is WRONG with an artefact. `/vet` asks whether what it SAYS is TRUE.** They fail differently and neither substitutes for the other: a claim can be perfectly reasoned, survive every adversarial round, and still be false about the file it cites. A reasoned claim that dies to one command is the shape this command exists to catch.

## Target Resolution

1. If `$ARGUMENTS` is a path, vet that file
2. If it names a workspace, vet its most recently modified draft under `workspaces/<project>/03-drafts/` (or `02-plans/` if no drafts dir)
3. If it is a quoted claim, verify that claim alone
4. Empty → the most recently modified file under `workspaces/*/03-drafts/`

## 1. Extract every checkable assertion

Sweep the target and enumerate assertions BEFORE verifying any of them — the enumeration is what makes coverage of the claim set auditable.

| Kind                | Pattern                                                     | Settled by                                             |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| **Citation**        | `file:line`, `§n`, a quoted passage, a rule/clause reference | opening the line and its neighbourhood, and reading it  |
| **Absence claim**   | "no X exists", "nothing specifies", "zero hits", "not yet built" | functional search with the terms RECORDED           |
| **Design decision** | "we add X", "define a new Y", "introduce Z"                 | functional search — **it is an absence claim in disguise** |
| **Count**           | "all N fields", "three occurrences", "58/58 runners"         | parsing or counting, never estimating                   |
| **Attribution**     | "their document says", "§12.1 concedes", "upstream declares" | the primary source, never a summary of it               |
| **Version/status**  | "@v1.1", "ratified", "published", "landed at `<sha>`"        | the artefact's own header, or the git object            |
| **Instrument claim**| "the check is green", "the sweep found none"                 | `rules/instrument-discipline.md` MUST-1 — name the falsifying result FIRST |

## 2. Verify each — against the artefact, never against the argument

- **Open the cited line AND its neighbourhood.** The sentence retrieved is routinely not the whole rule; a defect sitting four lines from a clause cited twice is the common shape.
- **A keyword search cannot establish absence.** Ask what the mechanism would be CALLED if it already existed, search THAT, and RECORD the terms. A count of one word is still a keyword search.
- **Parse, don't grep, when the claim is about a structure.** "Absent from the schema" is settled by enumerating the schema's fields, not by grepping its text.
- **A summary is not a source.** Never verify a claim about a document against a note about that document — including your own earlier note, and including a prior round's report.
- **A declaration is not the artefact.** A file saying a thing is canonical does not make the thing so; a manifest entry naming a path does not make the path exist.
- **Show the instrument fires HERE.** Before banking an empty result, fire the same instrument at a known-answer case (`rules/instrument-discipline.md` MUST-3). An empty result from an instrument never shown to fire is UNVERIFIABLE, not VERIFIED.
- **Read the hits, not the tally.** A count is not a finding, and a count counts whatever its producer decided it counts (MUST-3(b), MUST-4).

## 3. Grade every assertion

| Verdict           | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| **VERIFIED**      | Opened, and it says what the target claims                              |
| **OVERCLAIMED**   | Something is there; the claim is stronger than it                        |
| **MISLOCATED**    | True, wrong citation — record the real location                          |
| **FALSE**         | Checked; the claim does not hold                                        |
| **UNVERIFIABLE**  | Cannot be settled from artefacts reachable in scope — **say so, and why** |

**UNVERIFIABLE is a FINDING, not a pass.** A normative clause bound to a value no reachable artefact enumerates is unverifiable by construction, and that is the defect. Where the block is a scope boundary (a repo this session may not read per `rules/repo-scope-discipline.md`), record the boundary as the reason rather than inventing a workaround.

## 4. Claims about a third party's work get the primary source

Where the target makes a claim ABOUT someone else's artefact — especially a NEGATIVE claim ("their framework carries no X") — verify against the primary source, never a prior reading of it, and check the OTHER senses in which they use the term. A reader told "you have no exception model" will search their own document, find eight hits in three unrelated senses, and conclude you never read it. **Name the senses you are not talking about before naming the one you are.**

Cross-repo reading is NOT self-authorized: a primary source outside this repo needs a `/cross-repo-authorize` receipt at the correct tier BEFORE the read (`rules/repo-scope-discipline.md`). No receipt ⇒ the claim grades UNVERIFIABLE with the boundary named; fabricating a verification is BLOCKED.

## 5. Report

Write `workspaces/<project>/04-validate/NN-vet-<slug>.md`:

```markdown
# Vet: <target>

Date · Verified: N · Overclaimed: N · Mislocated: N · False: N · Unverifiable: N

## FALSE / OVERCLAIMED (blocks — each with the artefact that settles it)

## MISLOCATED (citation repair)

## UNVERIFIABLE (and why — this is a finding, not a pass)

## Search terms recorded (per absence claim / design decision)

## VERIFIED (so a later round need not re-open them)
```

**Record the search terms.** A future round must be able to re-test a claim without re-deriving how it was tested. **Record the falsifying result** for any instrument cited, per `rules/instrument-discipline.md` MUST-1.

## 6. Fix, then re-vet

Repair on discovery, sweep siblings (`rules/sweep-completeness.md`), and re-run until **0 FALSE and 0 OVERCLAIMED**. A corrected claim gets its correction recorded IN PLACE — **a note saying a fix was intended is not evidence one occurred**. Findings carry the categories of `rules/product-completion-first.md` MUST-1: a FALSE or OVERCLAIMED claim in a durable artefact is a BUG and is fixed to zero; an UNVERIFIABLE claim whose blocker is out of scope is a residual needing a named human acceptor per `rules/completion-criterion.md` MUST-6, never a silent pass.

## Relationship to /redteam

Run `/vet` **first** on a new draft — a false premise makes every downstream adversarial finding unreliable — then `/redteam` for coverage. Re-run `/vet` on anything `/redteam` FIXES: a fix is a new draft, and fixes introduce claim defects at the same rate drafts do. `/vet` findings are placed in the `/redteam` coverage table like any other (predominantly R2 correctness and R3 verifiability), and a claim graded FALSE **re-opens** its cell — and every other cell whose warrant cited the same lines — per `commands/redteam.md` § C1, until re-attacked and re-vetted. Shared depth: `skills/30-claude-code-patterns/role-conditioned-attackers.md`.

## Journal (MUST — phase-complete gate)

Before reporting `/vet` complete, create entries for journal-worthy results: **RISK** (a false claim that was load-bearing for a decision), **GAP** (a claim no reachable artefact can settle), **CONNECTION** (a capability found to already exist under another name). Use `/journal new <TYPE> <slug>` or write `workspaces/<project>/journal/NNNN-TYPE-slug.md`; check the highest `NNNN-` and increment. Skip only when the pass genuinely produced nothing journal-worthy. Do not batch.
