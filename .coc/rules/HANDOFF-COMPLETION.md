---
id: "HANDOFF-COMPLETION"
paths: [".claude/rules/**", ".claude/commands/**", "**/.session-notes*", "journal/**"]
---

# Handoff Completion — Delivered Or Surfaced, Never Implied-Done

A downstream-required action (a cross-repo issue/PR to file, an upstream handoff to make real, an external notification to send) is complete only when EXECUTED or EXPLICITLY surfaced as a PENDING action naming target + action + authorization. A local note ("handoff prepared") implying it is done — or citing a downstream artifact as existing when it was never created — is the **prepared ≠ delivered** failure: it silently moves the completion burden to the human, who never agreed and cannot see the gap. Depth (worked DO/DO-NOT, BLOCKED corpora, Origin): `.claude/guides/rule-extracts/handoff-completion.md`.

## MUST Rules

### 1. Executed Or Surfaced As Pending — Never Implied-Done

A deliverable that REQUIRES an action on another repo / external surface MUST either (a) EXECUTE it this session (a cross-repo write needs all five `repo-scope-discipline.md` User-Authorized-Exception conditions — never self-authorization), or (b) surface it — when done is claimed AND at wrap-up — as an EXPLICIT pending action naming target + action + authorization. A local note with no executed action and no pending-surface is BLOCKED; "the next session picks it up from the notes" is abandonment.

```markdown
# DO — execute, or surface the exact pending action (target + action + authorization)

# DO NOT — leave a local note ("handoff prepared") and treat the loop as closed
```

**Why:** Nobody downstream watches the note, so "prepared" becomes "never done" and the human finds the gap only by asking.

### 2. A Downstream Artifact Is Referenced As Existing Only After Created Or Verified This Session

A cross-repo issue/PR number, tracker, or "mirror" MUST NOT be referenced as EXISTING (comment, CHANGELOG, close message, handoff, notes) unless CREATED or VERIFIED this session (`gh issue view <n> --repo <r>`). Carrying a reference forward from prior-session prose or memory as current fact is BLOCKED — the cross-repo sibling of `verify-claims-before-write.md`.

```markdown
# DO — verify before citing, or explicitly mark the reference unverified

# DO NOT — cite an unverified cross-repo issue/PR/tracker as current fact
```

**Why:** An unverified downstream reference misdirects readers and hides that the artifact was never created — the shape that lets a "prepared" handoff look done.

### 3. When The Action Needs Authorization, ASK Specifically

When the action needs human authorization (`repo-scope-discipline.md` cross-repo write, `upstream-issue-hygiene.md` MUST-1 upstream filing), the session MUST make a SPECIFIC ask restating target repo + exact action for a yes/no. "Needs authorization" is a requirement to ASK, not a licence to stop at a note; a standing grant does not satisfy the per-action confirm-and-journal.

```markdown
# DO — specific, concrete authorization request (names target repo + exact action)

# DO NOT — treat "needs authorization" as permission to stop at a local note
```

**Why:** "It needed authorization" is the most plausible rationalization for prepared ≠ delivered — disciplined-sounding while doing nothing.

## MUST NOT

- Report a deliverable "done" / "handed off" / "prepared" when a required downstream action was neither executed nor explicitly surfaced as pending-with-authorization

**Why:** The originating failure mode — "prepared" reads as "delivered" and the action silently becomes the human's undocumented burden.

- Reference a cross-repo issue / PR / tracker as existing without creating or verifying it this session

**Why:** An unverified downstream reference is an unfalsifiable claim that hides a never-created artifact.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + cc-architect at `/codify` + the `/wrapup` review confirm any "handoff"/"prepared"/"mirror" language in session notes / PR bodies / issue comments is backed by an executed downstream action OR an explicit pending-action-with-authorization surface); `advisory` at the hook layer (a lexical "handoff prepared"-without-executed-action scan is judgment-bearing per `hook-output-discipline.md` MUST-2 and cannot carry `block`).
- **Grace period:** 7 days from rule landing at loom (2026-07-19 → 2026-07-26).
- **Cumulative posture impact:** same-class violations (a downstream-required action left implied-done in a local note; a cross-repo artifact referenced as existing without creation/verification) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a handoff-completion property is review-layer-only judgment; the universal `regression_within_grace` trigger already covers it).
- **Receipt requirement:** SessionStart soft-gate `[ack: handoff-completion]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + cc-architect at `/codify` + the `/wrapup` self-check inspect session notes / PR descriptions / issue comments for "handoff" / "prepared" / "mirror" / cross-repo-tracker references, and confirm each is backed by an executed action (a filed issue/PR URL, a verified issue number) OR an explicit pending-action surface naming target + action + authorization. Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — an advisory `Stop`/`PostToolUse` detector for "handoff prepared" / "mirror tracked in <ref>" without an adjacent executed-or-pending-surface, paired with the review layer per `probe-driven-verification.md` MUST-4; audit fixtures at `.claude/audit-fixtures/handoff-completion/` per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST-1 (implied-done downstream action) + MUST-2 (unverified downstream-artifact reference) + MUST-3 (needs-authorization treated as licence to stop at a note).
- **Origin:** See § Origin.

Origin: 2026-07-11 — co-owner-directed origination at the kailash-py BUILD repo; landed at loom via Gate-1 classification (journal/0550 B3). The BH5 session prepared a local Rust-SDK handoff doc, cited `rs#1714` as the BH5 tracker (it was the BH3 tracker), and reported the cross-SDK mirror "handoff prepared" without filing any Rust SDK issue. Verbatim directive: _"i already authorize you, if you don't specifically ask for it and just leave your notes locally and expect it to be magically done at kailash-rs or expect me to fill in the gaps for you, that's very irresponsible! please codify this unacceptable behavior and NEVER LET IT HAPPEN AGAIN!"_ Correction same session: filed rs#1732, corrected the `rs#1714` misreference on py #1510. Extended narrative + BLOCKED corpora: `.claude/guides/rule-extracts/handoff-completion.md`.
