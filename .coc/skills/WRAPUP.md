---
id: "WRAPUP"
name: wrapup
description: "/wrapup depth: the next-session directive contract (imperative + re-validation check), the free-for-the-next-session surfaces, and the forest-ledger mechanical gate."
---

# /wrapup — Session-Notes Depth

`commands/wrapup.md` carries the flow and the emitted format; THIS skill carries the depth it
references: (1) the per-surface detail of what the next session already gets for free, (2) what
`validate-forest-ledger.mjs` does and does NOT claim, and (3) the **next-session directive
contract** — the one imperative surface in the notes. The `.session-notes` layout, the ledger
reconciliation steps, and the Hard rules are OWNED by the command and are not restated here.

## 1. What the next session already has for free (per-surface)

The command's one-line list, expanded. Each of these is READ DIRECTLY by the next session, so
duplicating it into `.session-notes` spends the notes' 50-line budget on content that was already
free:

- **Commits & diffs** — `git log`, `git status`, `git diff`. This is why the accomplishments-list
  ban exists: local work is recoverable, external work (`## Executed this session`) is not.
- **Outstanding work** — `workspaces/<project>/todos/active/`. Per-task itemization lives here;
  the notes carry only the FOREST ledger.
- **Decisions & discoveries** — `workspaces/<project>/journal/`. Journal BEFORE `/wrapup`; the
  notes are not a decision log.
- **Phase outputs** — `01-analysis/`, `02-plans/`, `03-user-flows/`, `04-validate/`.
- **Domain specs** — `specs/` (detailed domain truth, always current).
- **Project context** — `CLAUDE.md`.

## 2. The forest-ledger mechanical gate — what each form claims

`validate-forest-ledger.mjs` runs in CI / `/redteam`, **never inside the `/wrapup` runtime** (the
4-tool-call cap forbids it). Three forms, three different claims:

| Form                     | What it checks                                                                                                                                | What it does NOT claim                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<notes>` (bare)         | Intra-file conformance: section present, fence-balanced, non-vacuous; rows anchored; IDs unique; every close entry references an ID + a receipt SHAPE | Makes **NO** anti-vanish claim. A prior open ID can disappear and the bare form stays green.                        |
| `--git-prior`            | Diffs the prior COMMITTED `.session-notes`; flags any prior open **ID** absent from BOTH current rows and the "Closed this session" list       | Nothing about workspace-stranded rows (that is `--aggregate`)                                                      |
| `--aggregate`            | Cross-file twin (#669): flags any open workspace-ledger ID absent from the ROOT ledger (reconciliation step 6; `/sweep` Sweep 6)               | Nothing about intra-file conformance of either file                                                                |

Receipt AUTHENTICITY is out of scope for all three — a fabricated receipt is a
`verify-resource-existence.md` MUST-1 matter, not this validator's. The validator checks the
receipt's SHAPE, never that the PR/SHA/journal exists.

## 3. The next-session directive contract

### The gap this closes

Every other section of `.session-notes` is DESCRIPTIVE — `Where we are`, `In-flight state`,
`Executed this session`, `Traps`, `Outstanding ledger` all record what IS. None is imperative.
`rules/session-notes-continuity.md` MUST-1 nonetheless asserts the fragment's job is carrying
**standing directives** — what this operator was told to do and has not finished. The contract
existed; the section that produces it did not.

### The four properties

1. **Imperative, not narrative.** "Merge #1776 before any re-cut", not "we were merging #1776".
2. **≤5, hard cap.** A sixth directive means the sixth-most-important thing is competing for the
   next session's first action with the first.
3. **Every directive carries its own re-validation command** — the command a future session runs
   to learn whether the directive is STILL TRUE, plus what result means still-true.
4. **Admission test:** if you cannot write the check, it is NOT a directive. It is context, and it
   goes in `Traps`. This is the test that keeps the section at 5.

### Written from memory — the checks are for the NEXT session

`/wrapup` is verification-FORBIDDEN (memory-only, 4-tool-call cap, `commands/wrapup.md` § Hard
rules). The directives AND their checks are authored from conversation memory. Running the checks
during wrapup to "confirm" them is BLOCKED — it breaks the cap and converts wrapup into the
verification cascade the cap exists to prevent. Nor are these a counted burn-down:
`rules/burn-down-reporting.md` MUST-3 fences the three-quantity burn-down off this surface
entirely, and a directive's check is a COMMAND for later, not a measured figure for now.

```markdown
# DO — imperative, capped, each with the command that expires it

## Next-session directives

1. **Merge #1776 before any Gate-2 re-cut** — the 5 open target PRs carry the pre-fix corpus.
   re-validate: `gh pr view 1776 --json state -q .state` → `MERGED` ⇒ this directive is DONE
2. **Get cross-repo authorization first** — the existing receipts are pinned to the old corpus.
   re-validate: read one receipt's `action:` → names the OLD SHA ⇒ it does NOT cover the new cut

# DO — the honest empty case

## Next-session directives

None — nothing carries forward.

# DO NOT — narrative, uncapped, uncheckable

## Next-session directives

1. We were partway through the Gate-2 re-cut and it seemed like the corpus was stale.
2. There are 122 content defects outstanding.        ← a figure, not a directive, and unverifiable
3. Be careful with the merge order.                  ← no check ⇒ this is a Trap, not a directive
4. …9 more…                                          ← past the cap; nothing is first any more
```

### Why the re-validation command is load-bearing

Directives decay silently between sessions, and a **stale directive is worse than none** because
the next session has no reason to doubt it — the notes are the one surface it treats as
authoritative before it has read anything else. Measured on the prototype session (2026-08-17,
loom session 38): the fragment carried a CORRECT directive (a load-bearing merge order) that saved
the session, AND a stale figure ("122 content defects", against a reviewer's measured 289
content-defect / 1425 distinct). Same file, same session, same register — **nothing in the text
distinguished them.** A paired check makes a directive self-invalidating: the next session runs
one command and learns which of the two it is holding, instead of inheriting both with equal
confidence. This is the same discrimination `rules/instrument-discipline.md` MUST-1 requires of
any check cited as evidence, moved one surface earlier — to the moment the claim is WRITTEN.

**BLOCKED rationalizations:**

- "The Traps section already covers it" (Traps is descriptive; a trap tells the next session what
  to avoid, a directive tells it what to DO — and only one of the two carries an expiry)
- "The next session can read the ledger" (the ledger is forest-level state, not an ordered
  instruction, and carries no expiry check either)
- "Writing checks is ceremony"
- "I will add the checks if someone asks"
- "Everything is a directive" (then nothing is — the ≤5 cap and the admission test are what make
  the section readable in the first 10 seconds of a session)
- "A directive with no check is still useful" (it is useful exactly until it goes stale, and it
  gives no signal when it does — that is the failure mode, not a residual risk)
- "I will verify the check now so the next session can trust it" (running it breaks the
  4-tool-call cap; the check is authored FOR the next session, not discharged by this one)
- "There is nothing to carry forward, so I will omit the section" (write the explicit sentinel —
  an absent section is indistinguishable from a forgotten one, the same reason the forest ledger
  writes "Forest empty")

### Sizing against the 300-line ceiling

`rules/session-notes-continuity.md` MUST-3 bounds every continuity artifact to a 150-line target
and a 300-line ceiling. A compliant directives section is 3 prose lines + ≤5 two-line entries ≈ 13
lines at maximum, ~4 lines in the common case, and 3 lines when empty. It is not what pushes an
artifact toward the ceiling; an unbounded `Where we are` narrative is.
