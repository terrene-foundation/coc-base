# `communication.md` — extended examples

Depth for `.claude/rules/communication.md`. The rule carries the contract (the MUST NOTs, their
`**Why:**` lines, the approval-gate questions and a compact DO/DO-NOT). This file carries the
worked examples that were inlined in the rule body until 2026-08-12, relocated verbatim under
`rule-authoring.md` Rule 10 path (a) so the always-injected surface stays lean.

Nothing here is new. If a line in this file disagrees with the rule, the rule wins.

## Report in Outcomes, Not Implementation

```
✅ "Users can now sign up and receive a welcome email."
❌ "Implemented POST /api/users endpoint with SendGrid integration."

✅ "The login page shows an error when too many people try to log in at once."
❌ "Connection pool exhaustion causing 503 on the auth endpoint under load."

✅ "The signup flow now works end-to-end."
❌ "Modified 12 files across 3 modules."
```

The pattern: name the change the user can observe, not the mechanism that produced it. A count of
modified files is a measure of your effort, not of their outcome.

## Explain Choices in Business Terms

When presenting decisions, explain implications in terms the user can act on — not implementation
details.

```
✅ "Should new users verify their email before they can log in?
   This adds a step to signup but prevents fake accounts and
   means you can reach every user by email later."
❌ "Should we add email verification middleware to the auth pipeline?"

✅ "The payment form can either validate cards instantly (faster checkout,
   costs $0.01 per check) or validate only on submit (free but users
   see errors later). Which matters more — speed or cost?"
❌ "Should we integrate the Stripe CardElement with real-time validation
   or defer to server-side charge creation?"
```

The ❌ forms are not wrong about the system; they are unanswerable by the person being asked. A
question a non-technical owner cannot answer is a question that has not been asked.

## Frame Decisions as Impact

Present four things: what each option does (plain language), what it means for users/business, the
trade-off, and your recommendation.

**Worked example:** "Two options for notifications. Option A: email only — simple, but users might
miss messages. Option B: email plus in-app — takes longer but ensures users see important updates.
I'd recommend B since your brief emphasizes real-time awareness."

Note the recommendation is present. Per `rules/recommendation-quality.md` MUST-3, laying out
options without picking one pushes the decision back onto the person with the least context.

## Approval Gates — why these four questions

At gates (end of `/todos`, before `/deploy`) the four questions in the rule body are chosen to
catch four distinct failure modes:

| Question | Failure mode it catches |
| --- | --- |
| "Does this cover everything you described in your brief?" | silent scope loss |
| "Is anything here that you didn't ask for or don't want?" | scope creep / unrequested work |
| "Is anything missing that you expected to see?" | the unstated assumption the brief never wrote down |
| "Does the order or sequence make sense?" | correct parts, wrong dependency order |

Asking a single "does this look right?" collapses all four into one question that reliably gets
"yes" and catches none of them.

## Related

- `rules/recommendation-quality.md` — that rule says ALSO recommend; this one says explain in terms
  the user can act on. They compose: explain the impact, then pick.
- `rules/value-prioritization.md` — what to report; this rule governs how.

## Origin + the parked demotion (relocated from the rule body)

Worked examples extracted here 2026-08-12 per `rule-authoring.md` Rule 10 path (a), to restore
rs-lane emission headroom. Every MUST NOT, its `**Why:**`, and the four approval-gate questions stay
in the rule body verbatim — only the ✅/❌ illustrations moved. Measured on both poles at `24dccb64`:
codex/gemini rs headroom 9.10% → 9.53% (369 → 633 B above the 8.5% floor); all 8 injection profiles
unchanged and within budget; emit-shape 85 pass / 0 fail.

**A co-owner-approved DEMOTION of this rule to path-scoped is PARKED, not abandoned**, and is blocked
on the INJECTION gate rather than on drafting. Measured: demoting with `paths: ["**/*"]` frees 1,617 B
of baseline emission (rs 9.10% → 11.73%, clearing the `#1355` 2026-10-31 expiry outright), but the
rule then joins every path-scoped profile and BREACHES two — `workspace-note` 411,021 B against a
410,135 B ceiling, `consumer-sdk-src` 177,158 B against 176,687 B. Cutting the rule further to fit was
rejected as de-scoping wearing an extraction's name. The correct order is: free injection room first
(the `["**/*"]` broad-load giants are the lever), then demote. Do not re-derive this — both poles are
measured above.

**Why this prose lives HERE and not in the rule:** it is provenance and a parked decision, not a
behavioural contract. Kept in the rule body it cost +464 B of BASELINE emission on every lane — which
inverted the extraction the same PR performed, so the PR measured as GROWING the baseline it was
opened to shrink. An extract is non-emitting; the record is preserved at zero baseline cost.
