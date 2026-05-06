# Claude Code Guides — CO & COC Reference

## Welcome

This documentation serves both the **CO artifact management platform** (this repo) and **COC development repos** (target repos that sync from here). Whether you're managing CO artifacts across stacks or using Claude Code for SDK development, these guides take you from zero to productive.

**What you'll learn:**

- What Claude Code actually is and how it differs from other AI tools
- How this specific setup enhances Claude Code with specialized knowledge
- How to use every feature effectively in your daily work
- How to troubleshoot common issues

---

## Quick Start Path

If you're in a hurry, follow this path:

1. **[01 - What is Claude Code?](01-what-is-claude-code.md)** - Understand the basics (10 min read)
2. **[03 - Installation and First Run](03-installation-and-first-run.md)** - Get started (15 min)
3. **[10 - Daily Workflows](10-daily-workflows.md)** - Start being productive (20 min)

Then come back and read the rest when you have time.

---

## Complete Guide Index

### Part 1: Foundations

| Guide                                                                   | Description                                                                                                                                   | Reading Time |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **[01 - What is Claude Code?](01-what-is-claude-code.md)**              | Understanding Claude Code from first principles. What it is, what it isn't, and why it's different from other AI tools.                       | 10-15 min    |
| **[02 - Understanding This Setup](02-understanding-this-setup.md)**     | A deep dive into the Kailash COC Claude (Python) architecture. Why we built it, what problems it solves, and how all the pieces fit together. | 20-25 min    |
| **[03 - Installation and First Run](03-installation-and-first-run.md)** | Step-by-step installation instructions with explanations of what's happening at each step. Your first conversation with Claude Code.          | 15-20 min    |

### Part 2: Core Systems

| Guide                                                     | Description                                                                                                                    | Reading Time |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **[04 - The Command System](04-the-command-system.md)**   | Understanding slash commands (`/sdk`, `/db`, `/test`, etc.). How they work, what they load, and when to use each one.          | 15-20 min    |
| **[05 - The Agent System](05-the-agent-system.md)**       | How specialized agents work, when Claude delegates to them, and how to work with the agent ecosystem effectively.              | 25-30 min    |
| **[06 - The Skill System](06-the-skill-system.md)**       | Understanding the knowledge base that powers Claude's expertise. How skills are organized and how Claude uses them.            | 20-25 min    |
| **[07 - The Hook System](07-the-hook-system.md)**         | Automation that runs before and after Claude's actions. How hooks enforce quality, security, and best practices automatically. | 20-25 min    |
| **[08 - The Rule System](08-the-rule-system.md)**         | Mandatory rules that govern Claude's behavior. Understanding constraints, quality gates, and why they exist.                   | 15-20 min    |
| **[09 - The Learning System](09-the-learning-system.md)** | How the setup learns from your usage patterns and improves over time. Observations, digest aggregation, and codification.      | 15-20 min    |

### Part 3: Practical Usage

| Guide                                             | Description                                                                                              | Reading Time |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------ |
| **[10 - Daily Workflows](10-daily-workflows.md)** | Common patterns for everyday development tasks. Building features, fixing bugs, writing tests, and more. | 25-30 min    |
| **[11 - Advanced Usage](11-advanced-usage.md)**   | Power user features, customization, extending the setup, and optimizing for your specific workflow.      | 20-25 min    |
| **[12 - Troubleshooting](12-troubleshooting.md)** | Common issues, error messages, and their solutions. When things go wrong and how to fix them.            | 15-20 min    |

### Part 4: Architect-Level Patterns

Advanced patterns distilled from the Claude Certified Architect curriculum and production experience with agentic systems.

| Guide                                                                       | Description                                                                                                                             | Reading Time |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **[13 - Agentic Architecture](13-agentic-architecture.md)**                 | Agentic loops, multi-agent orchestration, memory isolation, task decomposition, session management. The foundational architect pattern. | 25-30 min    |
| **[14 - Tool Design Patterns](14-tool-design-patterns.md)**                 | Tool descriptions as selection mechanism, the 4-5 tool limit, tool_choice modes, structured errors, MCP configuration.                  | 20-25 min    |
| **[15 - Prompt Engineering & Structured Output](15-prompt-engineering.md)** | Explicit criteria, few-shot examples, JSON schema design, validation-retry loops, batch processing, multi-instance review.              | 25-30 min    |
| **[16 - Context Management & Reliability](16-context-reliability.md)**      | Progressive summarization trap, lost-in-the-middle effect, escalation triggers, error propagation, information provenance.              | 20-25 min    |

---

## How to Use This Documentation

### For Absolute Beginners

Start with **Guide 01** and read sequentially. Each guide builds on concepts from previous guides. Don't skip ahead - the investment in understanding foundations pays off.

### For Experienced Developers New to Claude Code

Read **Guide 01** to understand Claude Code specifically, then jump to **Guide 02** to understand this setup. After that, **Guide 10** will get you productive quickly.

### For Quick Reference

Each guide has a "Quick Reference" section at the end summarizing key points. Use these for refreshers after you've read the full guide once.

### For Trainers

If you're training others on this setup, the recommended training path is:

1. Guides 01-03 in a first session (45-60 min)
2. Guides 04-06 in a second session (60-75 min)
3. Guides 07-09 in a third session (50-65 min)
4. Guides 10-12 as self-study with practical exercises

---

## Key Concepts Glossary

Before diving in, here are terms you'll encounter frequently:

| Term            | Definition                                                             |
| --------------- | ---------------------------------------------------------------------- |
| **Claude Code** | Anthropic's AI-powered command-line interface for software development |
| **Session**     | A single conversation with Claude Code, from start to end              |
| **Context**     | The information Claude has access to during a session                  |
| **Tool**        | An action Claude can take (read files, run commands, search, etc.)     |
| **Agent**       | A specialized sub-process Claude delegates to for specific tasks       |
| **Skill**       | A knowledge module that gives Claude expertise in a specific area      |
| **Hook**        | Automation that runs before or after specific events                   |
| **Command**     | A slash-prefixed shortcut (`/sdk`) that loads specific functionality   |
| **Rule**        | A mandatory constraint on Claude's behavior                            |
| **Workflow**    | In Kailash SDK context, a directed graph of nodes that processes data  |

---

## Getting Help

If you're stuck:

1. **Check the Troubleshooting Guide** - [Guide 12](12-troubleshooting.md)
2. **Ask Claude Code** - Type your question naturally; Claude can explain its own systems
3. **Use `/help`** - Shows available commands and options
4. **Check GitHub Issues** - https://github.com/anthropics/claude-code/issues

---

## About This Setup

This is the **Kailash CO Artifact Management Platform** — the canonical source for CO (Cognitive Orchestration) artifacts that get synced across all Kailash SDK stacks. It includes COC (CO for Codegen) content for target development repos.

The setup includes:

- **32 skill directories** covering SDK frameworks, standards, and patterns
- **37 specialized agents** for analysis, implementation, review, and standards
- **9 automation hooks** for quality enforcement and workspace awareness
- **23 slash commands** for management and knowledge access
- **26 rule files** for behavioral constraints (12 CO-general, 14 COC-specific)
- **4 learning scripts** for continuous improvement
- **4 architect-level guides** covering production agentic patterns

---

## Version Information

- **Setup Version**: 1.0.0
- **Claude Code Compatibility**: 2.1.x
- **Last Updated**: March 2026

---

## Navigation

- **[CLAUDE.md](CLAUDE.md)** - Entry point for Claude Code and developers
- **[01 - What is Claude Code?](01-what-is-claude-code.md)** - Start here if you're new
