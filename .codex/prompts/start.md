---
name: start
description: "New user orientation — explains the COC workflow and how to get started"
---

Present this orientation to the user in a warm, clear, jargon-free way. Adapt tone based on context — if they seem technical, be concise; if they seem new, take more time.

## What is COC?

COC is a structured workflow where YOU direct an AI to build software. You don't need to write code. Your job is to:

1. **Describe what you want** (in your own words, as detailed as you like)
2. **Make decisions** when choices come up (we'll always explain the options clearly)
3. **Approve the plan** before building starts
4. **Review the results** to make sure they match your vision

The AI handles all the technical work — writing code, testing, security checks, and deployment.

## The 5 Phases

| Step | Command | What Happens | Your Role |
|------|---------|-------------|-----------|
| 1. Research | `/analyze` | Study your idea — market fit, user needs, competition | Confirm we understood your vision |
| 2. Planning | `/todos` | Create a complete project roadmap | Approve the plan before building starts |
| 3. Building | `/implement` | Build the project one task at a time | Answer questions when choices come up |
| 4. Testing | `/redteam` | Test everything from a real user's perspective | Review results |
| 5. Knowledge | `/codify` | Capture what we learned for future sessions | Confirm the knowledge is accurate |

Plus **`/deploy`** when you're ready to launch, and **`/ws`** anytime to check progress.

## Getting Started

Walk the user through these steps:

1. **Create a workspace**: Ask the AI to set up a workspace for your project (e.g., "create a workspace called my-project"), or manually create a folder `workspaces/my-project/briefs/`
2. **Write a brief**: Create a file in the briefs folder describing what you want to build — in your own words, as detailed as you like. Include who it's for, what problem it solves, and what success looks like. You can also just tell the AI what you want and ask it to write the brief for you.
3. **Run `/analyze`**: This kicks off the research phase

If the user already has a workspace, show them their current status with `/ws` instead.

## Helpful Commands

- **`/ws`** — Check project status at any time
- **`/wrapup`** — Save your progress before ending a session (the AI picks up where you left off next time)
- **Ask anything** — You can always just type a question in plain language

## Tips for Non-Coders

Present these naturally, not as a lecture:

- **You don't need to understand code.** When the AI mentions technical things, ask it to explain in plain language.
- **Your knowledge is the most valuable input.** You know your users, your market, and your vision better than any AI.
- **"I don't understand" is always valid.** The AI will rephrase — no judgment.
- **Approval gates protect you.** Never approve something you don't fully understand. Ask questions first.
- **The AI remembers across sessions.** Run `/wrapup` before leaving, and your next session starts right where you left off.
