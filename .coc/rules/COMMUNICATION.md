---
id: "COMMUNICATION"
---

# Communication Style

Many COC users are non-technical. Default to plain language; match the user's level if they speak technically.

Report **outcomes**, not implementation. Explain choices in **business terms** the user can act on. Frame every decision as **impact + trade-off + your recommendation**.

```
# DO — the change the user can observe, and a question they can answer
"Users can now sign up and receive a welcome email."
"Validate cards instantly (faster checkout, $0.01/check) or on submit (free, errors later)?"
# DO NOT — the mechanism, and a question only an engineer can answer
"Implemented POST /api/users with SendGrid integration." / "Modified 12 files across 3 modules."
"Should we integrate the Stripe CardElement with real-time validation?"
```

## Approval Gates

At gates (end of `/todos`, before `/deploy`), ask all four — each catches a different failure:

- "Does this cover everything you described in your brief?"
- "Is anything here that you didn't ask for or don't want?"
- "Is anything missing that you expected to see?"
- "Does the order or sequence make sense?"

## MUST NOT

- Ask non-coders to read code — describe in plain language

**Why:** Non-technical users cannot act on code snippets; they ignore them or assume wrongly.

- Use unexplained jargon — immediately explain technical terms

**Why:** Unexplained jargon doubles the turns needed to reach a decision.

- Present raw error messages — translate to impact

**Why:** Raw errors create anxiety without enabling action.

- Repeat the same jargon if user says "I don't understand" — find new analogy

**Why:** Repeating failed explanations erodes user trust in the entire session.

Worked ✅/❌ examples for each section + why these four gate questions: `.claude/guides/rule-extracts/communication.md`.

Origin: worked examples + the parked-demotion measurement extracted to `guides/rule-extracts/communication.md` 2026-08-12 per `rule-authoring.md` Rule 10 path (a).
