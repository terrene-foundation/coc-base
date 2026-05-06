# Guide 03: Installation and First Run

## Introduction

This guide walks you through installing Claude Code and using it with this setup for the first time. Every step includes explanations of what's happening behind the scenes.

By the end of this guide, you will have:

- Claude Code installed and working
- This setup activated
- Completed your first successful interaction
- Understanding of what's happening at each stage

---

## Part 1: Prerequisites

### What You Need

Before installing Claude Code, ensure you have:

| Requirement  | Minimum Version     | Check Command    |
| ------------ | ------------------- | ---------------- |
| **Node.js**  | 18.0.0              | `node --version` |
| **npm**      | 8.0.0               | `npm --version`  |
| **Git**      | 2.30.0              | `git --version`  |
| **Terminal** | Any modern terminal | -                |

### Operating System Support

| OS      | Supported | Notes                               |
| ------- | --------- | ----------------------------------- |
| macOS   | ✅ Yes    | Native support                      |
| Linux   | ✅ Yes    | Native support                      |
| Windows | ✅ Yes    | WSL recommended for best experience |

### Anthropic Account

You need an Anthropic account with API access:

1. Go to https://console.anthropic.com
2. Create an account or log in
3. Navigate to API keys
4. Create a new API key
5. Save it securely (you'll need it during setup)

---

## Part 2: Installing Claude Code

### Step 1: Install via npm

Open your terminal and run:

```bash
npm install -g @anthropic-ai/claude-code
```

**What's happening**: This installs Claude Code globally on your system, making the `claude` command available anywhere.

### Step 2: Verify Installation

Run:

```bash
claude --version
```

**Expected output**: Something like `claude-code version 2.1.15`

If you see a version number, installation was successful.

### Step 3: Authenticate

Run Claude Code for the first time:

```bash
claude
```

**What happens next**:

1. Claude Code will detect this is your first run
2. It will prompt you to authenticate
3. Follow the prompts to connect your Anthropic account

There are several authentication methods:

- **Browser authentication** (recommended): Opens your browser to complete login
- **API key**: Paste your API key directly
- **Environment variable**: Set `ANTHROPIC_API_KEY` in your shell

**Recommended**: Use browser authentication for the smoothest experience.

---

## Part 3: Setting Up This Configuration

### Step 1: Clone or Navigate to This Setup

If you have this setup as a repository:

```bash
git clone [repository-url] kailash-coc-claude-py
cd kailash-coc-claude-py
```

Or if you're already in the directory:

```bash
cd /path/to/kailash-coc-claude-py
```

### Step 2: Verify the Setup Structure

Check that the key files exist:

```bash
ls -la .claude/
```

**Expected output**:

```
drwxr-xr-x  agents/
drwxr-xr-x  commands/
drwxr-xr-x  guides/
drwxr-xr-x  rules/
drwxr-xr-x  skills/
-rw-r--r--  settings.json
```

### Step 3: Start Claude Code in This Directory

From the project root:

```bash
claude
```

**What happens when Claude Code starts**:

1. **Settings Load**: Claude Code reads `.claude/settings.json`
   - This configures the 9 hooks
   - Hooks will now run automatically

2. **CLAUDE.md Load**: Claude reads the project's `CLAUDE.md`
   - This contains project-specific instructions
   - Claude now knows about Kailash SDK

3. **Session Start Hook**: `session-start.js` runs
   - Detects active frameworks
   - Checks environment setup
   - Logs session observation

4. **Ready State**: Claude is now ready with full context

---

## Part 4: Your First Interaction

### Understanding the Interface

When Claude Code starts, you'll see:

```
╭─────────────────────────────────────────────────╮
│ ✻ Claude Code                                   │
│                                                 │
│   Working in: /path/to/kailash-coc-claude-py    │
╰─────────────────────────────────────────────────╯

>
```

The `>` prompt is where you type your requests.

### Basic Commands

Before diving into development tasks, know these essential commands:

| Command   | What It Does                |
| --------- | --------------------------- |
| `/help`   | Show all available commands |
| `/clear`  | Clear the current context   |
| `/exit`   | Exit Claude Code            |
| `/status` | Show current session status |

### Loading Skill Context

To load specific knowledge, use skill commands:

```
> /sdk
```

**What happens**:

1. Claude loads the Core SDK skill
2. You see confirmation of what was loaded
3. Claude now has SDK patterns in context

Try loading other skills:

- `/db` - DataFlow patterns
- `/api` - Nexus patterns
- `/ai` - Kaizen patterns
- `/test` - Testing patterns

### Your First Request

Let's try a simple request:

```
> Explain the basic workflow pattern for Kailash SDK
```

**What happens**:

1. Claude accesses the `01-core-sdk` skill
2. Retrieves the workflow pattern
3. Explains it to you

**Expected response**: Claude will explain the WorkflowBuilder pattern, node addition, connections, and runtime execution.

### A More Complex Request

Now try something that triggers multiple components:

```
> Create a simple DataFlow model for storing user data with name and email
```

**What happens behind the scenes**:

1. **Skill Access**: Claude loads `02-dataflow` skill
2. **Pattern Application**: Uses `@db.model` pattern
3. **Hook Validation**: `validate-workflow.js` checks the output
4. **Rule Compliance**: Ensures primary key is named `id`

**Expected output**: A DataFlow model definition with proper patterns.

---

## Part 5: Understanding What You See

### Tool Usage Indicators

When Claude uses tools, you'll see indicators:

```
[Reading src/models/user.py...]
```

This means Claude is using the Read tool.

```
[Editing src/models/user.py...]
```

This means Claude is using the Edit tool.

```
[Running: npm test...]
```

This means Claude is using the Bash tool.

### Hook Messages

When hooks run, you may see messages:

```
[Hook] validate-workflow: All patterns validated
```

This indicates a hook ran and what it found.

### Agent Delegation

When Claude delegates to an agent:

```
Delegating to dataflow-specialist for this task...
```

You'll see the agent's response integrated into Claude's answer.

---

## Part 6: Testing the Setup

### Test 1: Pattern Validation

Try writing incorrect code to see if hooks catch it:

```
> Write a workflow that uses workflow.execute(runtime) instead of the correct pattern
```

Claude should:

1. Recognize this as an anti-pattern
2. Warn you about the correct pattern
3. Use `runtime.execute(workflow.build())` instead

### Test 2: Security Awareness

Try a security-related request:

```
> Review this code for security issues: api_key = "sk-12345"
```

Claude should:

1. Identify the hardcoded secret
2. Recommend using environment variables
3. Show the correct pattern

### Test 3: Testing Policy

Ask about testing:

```
> How should I write integration tests for DataFlow models?
```

Claude should:

1. Reference the Real infrastructure recommended policy
2. Show real database testing patterns
3. Use SQLite in-memory for examples

---

## Part 7: Common First-Run Issues

### Issue: "Command not found: claude"

**Cause**: npm global binaries not in PATH

**Fix**:

```bash
# Find npm global bin path
npm config get prefix

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Issue: "Authentication failed"

**Cause**: Invalid or expired API key

**Fix**:

1. Go to https://console.anthropic.com
2. Create a new API key
3. Run `claude` again and re-authenticate

### Issue: "No .claude directory found"

**Cause**: Not in the correct directory

**Fix**:

```bash
# Navigate to the setup directory
cd /path/to/kailash-coc-claude-py

# Verify .claude exists
ls -la .claude/
```

### Issue: "Hook timeout"

**Cause**: Slow hook execution

**Fix**:

1. Check network connectivity
2. Verify Node.js is working: `node --version`
3. Check hook files are executable

---

## Part 8: Next Steps

### Explore Available Commands

List all commands:

```
> /help
```

### Try Each Skill Command

Experience what each skill provides:

```
> /sdk
> /db
> /api
> /ai
> /test
> /validate
```

### Make a Real Request

Try building something real:

```
> Create a simple CRUD workflow for a Task model with title and status fields using DataFlow
```

---

## Part 9: Key Takeaways

### Summary

1. **Installation is via npm** - Global install gives you the `claude` command

2. **Authentication connects to Anthropic** - Browser auth is smoothest

3. **This setup activates automatically** - When you run `claude` in this directory

4. **Hooks run automatically** - You don't need to invoke them

5. **Skills load via commands** - `/sdk`, `/db`, `/api`, etc.

6. **Claude confirms tool usage** - You see what it's reading/editing/running

### Quick Reference

| Action              | Command  |
| ------------------- | -------- |
| Start Claude Code   | `claude` |
| Get help            | `/help`  |
| Load Core SDK skill | `/sdk`   |
| Load DataFlow skill | `/db`    |
| Exit                | `/exit`  |
| Clear context       | `/clear` |

---

## What's Next?

Now that you're up and running, the next guide explains the command system in detail.

**Next: [04 - The Command System](04-the-command-system.md)**

---

## Navigation

- **Previous**: [02 - Understanding This Setup](02-understanding-this-setup.md)
- **Next**: [04 - The Command System](04-the-command-system.md)
- **Home**: [README.md](README.md)
