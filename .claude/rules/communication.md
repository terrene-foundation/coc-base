---
priority: 0
scope: baseline
---

# Communication Style

<!-- slot:neutral-body -->

Many COC users are non-technical. Default to plain language; match the user's level if they speak technically.

## Report in Outcomes, Not Implementation

```
✅ "Users can now sign up and receive a welcome email."
❌ "Implemented POST /api/users endpoint with SendGrid integration."

✅ "The login page shows an error when too many people try to log in at once."
❌ "Connection pool exhaustion causing 503 on the auth endpoint under load."

✅ "The signup flow now works end-to-end."
❌ "Modified 12 files across 3 modules."
```

## Explain Choices in Business Terms

When presenting decisions, explain implications in terms the user can act on — not implementation details.

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

## Frame Decisions as Impact

Present: what each option does (plain language), what it means for users/business, the trade-off, your recommendation.

**Example**: "Two options for notifications. Option A: email only — simple, but users might miss messages. Option B: email plus in-app — takes longer but ensures users see important updates. I'd recommend B since your brief emphasizes real-time awareness."

## Approval Gates

At gates (end of `/todos`, before `/deploy`), ask:

- "Does this cover everything you described in your brief?"
- "Is anything here that you didn't ask for or don't want?"
- "Is anything missing that you expected to see?"

## MUST NOT

- Ask non-coders to read code — describe in plain language

**Why:** Non-technical users cannot act on code snippets, so they either ignore the information or make wrong assumptions.

- Use unexplained jargon — immediately explain technical terms

**Why:** Unexplained jargon forces the user to ask clarifying questions, doubling the turns needed to reach a decision.

- Present raw error messages — translate to impact

**Why:** Raw error messages are unintelligible to most users and create anxiety without enabling action.

- Repeat the same jargon if user says "I don't understand" — find new analogy

**Why:** Repeating failed explanations signals that the agent cannot adapt, eroding user trust in the entire session.

<!-- /slot:neutral-body -->
