# Guide 01: What is Claude Code?

## Introduction

This guide explains Claude Code from the ground up. If you've never used Claude Code before, or if you're coming from other AI coding tools and want to understand what makes Claude Code different, this guide is for you.

By the end of this guide, you will understand:
- What Claude Code actually is
- How it differs from other AI coding tools
- The fundamental concepts you need to know
- What Claude Code can and cannot do

---

## Part 1: The Basics

### What is Claude Code?

Claude Code is **Anthropic's official command-line interface (CLI) for Claude**, their AI assistant. It's a tool that runs in your terminal and helps you with software development tasks.

Think of it this way:
- **Claude** is Anthropic's AI model (like GPT is to OpenAI)
- **Claude Code** is a specific application that uses Claude for coding

When you use Claude Code, you're having a conversation with an AI that can:
- Read your code files
- Write new code
- Run terminal commands
- Search the web
- Navigate your project

### How is it Different from ChatGPT or Copilot?

| Feature | ChatGPT | GitHub Copilot | Claude Code |
|---------|---------|----------------|-------------|
| **Primary Interface** | Web browser | Code editor | Terminal |
| **File Access** | None (paste code) | Current file | Entire project |
| **Can Run Commands** | No | No | Yes |
| **Can Edit Files** | No | Yes (suggestions) | Yes (directly) |
| **Project Awareness** | None | Limited | Full |
| **Multi-Step Tasks** | Manual | Limited | Autonomous |

The key difference: **Claude Code can take actions, not just give advice.**

When you tell Claude Code "fix the bug in app.py", it can:
1. Read app.py
2. Understand the context
3. Identify the bug
4. Edit the file directly
5. Run tests to verify the fix
6. Report back to you

Other tools give you suggestions. Claude Code does the work.

### The Terminal Interface

Claude Code runs in your terminal. Here's what a session looks like:

```
$ claude

╭─────────────────────────────────────────────────╮
│ ✻ Claude Code                                   │
│                                                 │
│   Your AI coding partner in the terminal        │
╰─────────────────────────────────────────────────╯

> What would you like to do?
```

You type your request in natural language:

```
> Fix the authentication bug in src/auth.py that's causing login failures
```

Claude responds conversationally and takes action:

```
I'll investigate the authentication bug. Let me start by reading the auth.py file.

[Reading src/auth.py...]

I found the issue. On line 47, the password comparison is using `==` instead
of a secure comparison function, which is vulnerable to timing attacks and
also failing because of encoding issues.

Let me fix this:

[Editing src/auth.py...]

Done. I've replaced the insecure comparison with `secrets.compare_digest()`.
Would you like me to run the tests to verify the fix?
```

---

## Part 2: Core Concepts

### Concept 1: Sessions

A **session** is a single conversation with Claude Code, from the moment you start it to when you exit.

```
$ claude          # Session starts
...
> /exit           # Session ends
```

Within a session:
- Claude remembers everything you've discussed
- Claude maintains context about your project
- Actions build on previous actions

Between sessions:
- Claude starts fresh (no memory of previous sessions)
- Your files retain any changes made
- Some context is preserved in configuration files

**Why this matters**: If you're working on a complex task, try to complete it in one session. If you need to continue later, provide context about what you were doing.

### Concept 2: Tools

Claude Code has access to **tools** - actions it can take in your environment. The main tools are:

| Tool | What It Does | Example |
|------|--------------|---------|
| **Read** | Read file contents | Reading `src/app.py` to understand code |
| **Write** | Create new files | Creating `tests/test_auth.py` |
| **Edit** | Modify existing files | Fixing a bug in `src/auth.py` |
| **Bash** | Run terminal commands | Running `npm install` or `pytest` |
| **Glob** | Find files by pattern | Finding all `*.py` files in `src/` |
| **Grep** | Search file contents | Finding all uses of `login_user()` |
| **WebSearch** | Search the internet | Looking up Python documentation |
| **WebFetch** | Get web page content | Fetching a specific documentation page |

When you make a request, Claude decides which tools to use and uses them automatically.

### Concept 3: Context

**Context** is the information Claude has access to during your session. Context includes:

1. **Your request** - What you just asked
2. **Previous conversation** - Everything said in this session
3. **Project files** - Files Claude has read
4. **Configuration** - Settings and instructions (like CLAUDE.md)
5. **Tool results** - Output from commands and file reads

Context is limited. If you give Claude too much information at once, older information may be forgotten. This is called "context window limits."

**Why this matters**: Be focused in your requests. Instead of "look at everything and find problems", say "review src/auth.py for security issues."

### Concept 4: The CLAUDE.md File

Every project can have a `CLAUDE.md` file at its root. This file contains **project-specific instructions** that Claude reads at the start of every session.

Example CLAUDE.md:

```markdown
# Project Instructions

## Code Style
- Use Python 3.11+ features
- Follow PEP 8 guidelines
- Write docstrings for all public functions

## Testing
- All new code must have tests
- Use pytest for testing
- Maintain 80% coverage

## Important Notes
- The database password is in .env (never commit)
- The API uses JWT authentication
- Frontend is in /client, backend in /server
```

When Claude starts, it reads this file and follows these instructions throughout the session.

---

## Part 3: What Claude Code Can Do

### Capability 1: Code Understanding

Claude can read and understand your entire codebase:

```
> Explain how the authentication flow works in this project
```

Claude will:
- Find relevant files (auth.py, login.py, middleware.py)
- Read and analyze them
- Explain the flow in plain English
- Point out potential issues

### Capability 2: Code Writing

Claude can write new code based on your requirements:

```
> Create a new API endpoint for user registration with email verification
```

Claude will:
- Understand your existing code patterns
- Write the new endpoint
- Write the email verification logic
- Add tests for the new code
- Update any necessary imports

### Capability 3: Bug Fixing

Claude can find and fix bugs:

```
> The login is failing with "invalid token" error. Debug and fix it.
```

Claude will:
- Search for relevant error messages
- Trace the code flow
- Identify the root cause
- Fix the issue
- Verify the fix works

### Capability 4: Refactoring

Claude can improve existing code:

```
> Refactor the database module to use connection pooling
```

Claude will:
- Understand current implementation
- Design the new approach
- Make the changes
- Ensure all tests pass
- Update documentation

### Capability 5: Testing

Claude can write and run tests:

```
> Write integration tests for the user registration flow
```

Claude will:
- Analyze what needs testing
- Write comprehensive tests
- Run the tests
- Fix any failures
- Report results

### Capability 6: System Operations

Claude can run commands and manage your environment:

```
> Set up the development environment and run the project
```

Claude will:
- Check dependencies
- Install missing packages
- Set up configuration
- Start the application
- Report any issues

---

## Part 4: What Claude Code Cannot Do

Understanding limitations is as important as understanding capabilities.

### Limitation 1: No Persistent Memory

Claude doesn't remember previous sessions. Each session starts fresh. If you worked on something yesterday, Claude won't remember it today.

**Workaround**: Use CLAUDE.md to document important project context. At the start of a new session, briefly describe what you're continuing.

### Limitation 2: No External Access (Beyond Web)

Claude can search the web and fetch pages, but it cannot:
- Access private networks
- Log into websites
- Use APIs that require authentication (unless you provide credentials)
- Access databases directly (it can run commands that do)

### Limitation 3: No GUI Interaction

Claude works in the terminal. It cannot:
- Click buttons in applications
- Interact with browser windows
- Take screenshots
- Use graphical interfaces

**Workaround**: For testing that requires GUI interaction, Claude can suggest manual steps or help set up automated testing frameworks like Playwright.

### Limitation 4: Context Limits

Claude has a finite context window. Very large files or very long sessions may exceed this limit. When this happens:
- Claude may forget earlier parts of the conversation
- The system will summarize to make room

**Workaround**: Keep sessions focused. For very large codebases, work on specific areas rather than trying to hold everything in context.

### Limitation 5: No Real-Time Awareness

Claude doesn't know what's happening in real-time outside of what you tell it. If a server is running in the background, Claude only knows what you share.

**Workaround**: Share relevant output with Claude. "The server says: [paste output]"

---

## Part 5: The Conversation Model

### How to Talk to Claude Code

Claude understands natural language. You don't need special syntax for basic requests.

**Good examples:**
- "Fix the bug in login.py"
- "Create a new user model with name, email, and password"
- "Why is this test failing?"
- "Explain what this function does"

**Avoid being too vague:**
- ❌ "Make it better"
- ✅ "Improve the performance of the database queries in user.py"

### Giving Feedback

Claude learns from your feedback during a session. If something isn't right:

```
> That's not quite right. The function should return a dictionary, not a list.
```

Claude will acknowledge the correction and adjust.

### Asking Questions

Claude can explain anything it does:

```
> Why did you choose to use a class here instead of a function?
```

Claude will explain its reasoning, which helps you learn and verify its approach is correct.

### Multi-Step Tasks

For complex tasks, Claude will often ask clarifying questions:

```
> Create a complete authentication system

Claude: I'll create an authentication system. A few questions:
1. Should I use session-based auth or JWT tokens?
2. Do you need password reset functionality?
3. Should I include OAuth (Google, GitHub login)?
```

Answer these questions to guide Claude in the right direction.

---

## Part 6: Safety and Security

### What Claude Won't Do

Claude has built-in safety measures. It will refuse to:
- Generate malware or exploits
- Help with illegal activities
- Execute commands that could destroy your system (like `rm -rf /`)
- Commit secrets to version control (it will warn you)

### Code Review Mindset

Even though Claude is helpful, treat its output like you would code from any developer - review it before deploying.

Claude can:
- Make mistakes
- Misunderstand requirements
- Produce code that works but isn't optimal

Always review important changes before committing.

### Secrets and Credentials

Claude will warn you about potential secret leaks. If it sees something like an API key in code, it will suggest moving it to environment variables.

Best practice: Use `.env` files and keep secrets out of your code.

---

## Part 7: Key Takeaways

### Summary

1. **Claude Code is a terminal-based AI coding partner** that can take actions, not just give advice

2. **Sessions are conversations** - Claude remembers context within a session but starts fresh each time

3. **Tools are actions** - Claude can read files, write code, run commands, and more

4. **CLAUDE.md provides project context** - Use it to give Claude persistent instructions

5. **Context has limits** - Keep sessions focused and be specific in requests

6. **Claude has boundaries** - It can't remember across sessions, access GUIs, or work with unlimited file sizes

7. **Natural conversation works** - Talk to Claude like a colleague, but be specific about requirements

### Quick Reference

| I Want To... | Example Command |
|--------------|-----------------|
| Start Claude Code | `$ claude` |
| Exit Claude Code | `> /exit` |
| Get help | `> /help` |
| Clear context | `> /clear` |
| Read a file | "Read the main.py file" |
| Fix a bug | "Fix the login bug in auth.py" |
| Create something | "Create a user registration endpoint" |
| Run tests | "Run all the tests" |
| Explain code | "Explain how this function works" |

---

## What's Next?

Now that you understand what Claude Code is, the next guide explains how this specific setup (Kailash COC Claude (Python)) enhances Claude Code with specialized knowledge and automation.

**Next: [02 - Understanding This Setup](02-understanding-this-setup.md)**

---

## Navigation

- **Previous**: [README.md](README.md)
- **Next**: [02 - Understanding This Setup](02-understanding-this-setup.md)
- **Home**: [README.md](README.md)
