# Handoff-Completion Discipline — Extract

Depth-extract for the baseline rule `.claude/rules/handoff-completion.md`. The rule's three MUST clauses carry the CLI-neutral contract + a compact one-line DO/DO-NOT each; this file carries the full worked examples, the BLOCKED-rationalization corpora, and the extended Origin narrative. Read it before authoring or auditing any "handoff" / "prepared" / "mirror" / cross-repo-tracker claim, and when a gate-review (reviewer at `/redteam`, cc-architect at `/codify`, the `/wrapup` self-check) audits a done/handed-off/prepared claim.

The failure mode the rule names is **prepared ≠ delivered**: a session writes a local note (a handoff doc, a `.session-notes` line, a "prepared" summary) and leaves the actual downstream action — a cross-repo issue or PR that must be filed, an upstream handoff that must become a real artifact, an external notification that must be sent — implied-done. The note silently transfers the completion burden to the human, who neither agreed to it nor can see the gap, and it rots into never-done. Referencing a downstream artifact as if it exists when it was never created is the same failure at the citation surface.

## MUST-1 — Executed Or Explicitly Surfaced As Pending

### DO / DO NOT

```markdown
# DO — either execute, or surface the exact pending action

Executed: filed the BH5 mirror issue on the Rust SDK BUILD repo (#1732).
— OR —
PENDING (needs your authorization): file a BH5 mirror issue on the Rust SDK
BUILD repo. I cannot self-authorize a cross-repo write; authorize and I file
it now (scrubbed body shown first).

# DO NOT — leave a local note and treat the loop as closed

"Handoff prepared at workspaces/.../rs-1732-circuit-breaker.md; the Rust SDK
mirror remains the cross-SDK lockstep." # no issue filed, nothing asked — # the human is silently on the hook
```

### BLOCKED rationalizations

- "The handoff doc captures it; someone will file it"
- "I referenced the tracker; the rs side will see it"
- "The notes say it's pending; that's surfacing it"
- "It needs authorization, so leaving a note is the safe default"
- "The next session will pick it up from the session notes"
- "I added it to the workspace todos / backlog; the next /implement will action it"
- "It's tracked in a local issue draft, that's good enough"

**Why:** A local note is invisible on the surface that actually needs the action (the other repo); nobody downstream is watching the note, so "prepared" becomes "never done" and the human discovers the gap only by asking. Executing it, or naming it as an explicit pending action with its authorization requirement, is the only disposition that closes the loop. A cross-repo write requires ALL FIVE `repo-scope-discipline.md` User-Authorized-Exception conditions (user-initiated, explicit+specific, confirmed, journaled-before-acting, scoped-exactly) — never self-authorization; the "surface it as pending" branch is exactly what the agent does when it cannot self-authorize.

## MUST-2 — Referenced As Existing Only After Created Or Verified This Session

### DO / DO NOT

```markdown
# DO — verify before referencing, or mark it unverified

Verified rs#1732 open (filed this session). / "rs#1714" — unverified; check before citing.

# DO NOT — reference an unverified cross-repo artifact as current fact

"the remaining lockstep is tracked in rs#1714" # never verified; rs#1714 was # actually a DIFFERENT primitive
```

### BLOCKED rationalizations

- "The tracker number is in my notes, it's fine to cite it"
- "The prior session established rs#NNNN as the tracker"
- "It's the same primitive, the number is close enough"
- "I referenced it last time, it must still be open"
- "`gh issue view` is an extra step; the reference is obviously right"

**Why:** An unverified downstream reference stated as fact misdirects every reader who trusts it, and hides that the artifact was never created — the exact shape that let a "prepared" handoff look done. One `gh issue view` before citing is the whole cost. This is the cross-repo sibling of `verify-claims-before-write.md` MUST-2 and `verify-resource-existence.md` MUST-2 (a cross-repo issue number is a resource-existence claim).

## MUST-3 — When The Action Needs Authorization, ASK Specifically

### DO / DO NOT

```markdown
# DO — specific, concrete authorization request

"To close the cross-SDK loop I need to file an issue on <target repo>. Authorize
and I'll draft the scrubbed body, journal the grant, and file it. (y/N)"

# DO NOT — treat "needs authorization" as permission to stop at a note

"Filing the mirror needs a cross-repo grant, so I've left the handoff in the
workspace." # never asked; the human must now discover and drive it
```

### BLOCKED rationalizations

- "It needs authorization, so leaving a note is the safe default"
- "I can't self-authorize a cross-repo write, so I've done all I can"
- "The user has a standing 'I authorize you', a specific ask is redundant"
- "Asking again is nagging; the note documents what's needed"
- "Surfacing the requirement in notes IS the ask"

**Why:** "It needed authorization" is the most plausible-sounding rationalization for the prepared ≠ delivered failure — it sounds disciplined while doing nothing. The discipline is to gate the ACTION behind a specific ask, not to substitute a local note for the ask. A blanket standing grant ("i already authorize you") still does not satisfy `repo-scope-discipline.md`'s per-action confirm-and-journal, so the specific ask is still required.

## Cross-references

- **Sibling of** `build-repo-release-discipline.md` ("done means released, not merged") — one layer out, to cross-repo handoffs.
- **MUST-2 pairs with** `verify-claims-before-write.md` MUST-2 + `verify-resource-existence.md` MUST-2 (a cross-repo issue number is a resource-existence claim).
- **MUST-1/3 depend on** `repo-scope-discipline.md` User-Authorized-Exception (the five conditions for any cross-repo write) + `upstream-issue-hygiene.md` MUST-1 (human-gated upstream filing).

## Extended Origin

2026-07-11 — co-owner-directed origination at the kailash-py BUILD repo; landed at loom via Gate-1 classification (journal/0550 B3). The BH5 session prepared a local Rust-SDK handoff doc, referenced `rs#1714` as the BH5 lockstep tracker (it was actually the BH3 tracker), and reported the cross-SDK mirror as "handoff prepared" without filing any issue on the Rust SDK repo — leaving the completion for the human to infer and drive. Verbatim directive: _"i already authorize you, if you don't specifically ask for it and just leave your notes locally and expect it to be magically done at kailash-rs or expect me to fill in the gaps for you, that's very irresponsible! please codify this unacceptable behavior and NEVER LET IT HAPPEN AGAIN!"_ Correction executed the same session: filed rs#1732 (the BH5 circuit-breaker cross-SDK parity issue), corrected the `rs#1714` misreference on py #1510, and codified this rule. BUILD-side grant/receipt: `journal/0010` / `journal/0011`; codify redteam amendment `journal/0012`. Two loom-canonical follow-ups — whether MUST-2 relocates to the path-scoped `verify-claims-before-write.md`, and whether this rule joins the `self-referential-codify.md` Rule 2 allowlist (MUST-2 fires on codify-class output) — are flagged for loom Gate-1 (Wave-3 decides).
