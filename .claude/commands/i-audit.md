---
name: i-audit
description: "Design quality audit with AI-slop detection — enterprise SaaS UI inspection."
---

# /i-audit - Design Quality Audit with AI Slop Detection

## Purpose

Perform a comprehensive design quality audit on frontend code. Evaluates visual quality, interaction design, and — critically — detects telltale patterns of AI-generated "slop" aesthetics.

Adapted from [Impeccable](https://impeccable.style/) (Apache 2.0), enhanced with Kailash enterprise AI evaluation criteria.

## Usage

| Command               | Action                                                                   |
| --------------------- | ------------------------------------------------------------------------ |
| `/i-audit`            | Full 10-dimension design audit of current file/component                 |
| `/i-audit $ARGUMENTS` | Focused audit on a specific area (e.g., `typography`, `color`, `motion`) |

## Audit Process

### Step 1: Context Gathering (Mandatory)

Before auditing, gather:

1. **What framework?** (React, Flutter, vanilla HTML/CSS)
2. **What component/page?** (Read the target files)
3. **Existing design system?** (Check for design tokens, theme files)
4. **Target audience?** (Enterprise SaaS users vs consumer vs internal tool)

### Step 2: AI Slop Test (CRITICAL -- Run First)

Check for 2024-2025 AI-generation fingerprints across 5 categories. If 3+ fingerprints found, flag as FAIL:

- **Typography**: Inter/Roboto without reasoning, uniform `font-weight: 600`, no typographic scale, default `1.5` line-height everywhere
- **Color**: Purple-to-blue gradients, neon accents on dark backgrounds, Tailwind default hero colors (`#6366F1` / `#8B5CF6` / `#3B82F6`), identical opacity overlays
- **Layout**: Cards-in-cards nesting, perfectly uniform spacing (no rhythm), everything centered, identical-card grids as default
- **Visual Effects**: Glassmorphism everywhere, uniform `rounded-2xl`, `shadow-lg` on every card (no hierarchy), gratuitous gradient text
- **Motion**: `transition-all` instead of targeted properties, identical 300ms timing, bounce/elastic easing, purposeless animations

**Verdict**: PASS / MARGINAL / FAIL with specific fingerprints listed.

### Step 3: 10-Dimension Evaluation

Rate each dimension 1-5 (1=critical issues, 5=excellent):

| #   | Dimension                    | What to Evaluate                                                                                |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Visual Hierarchy**         | Do important elements draw attention first? Is there clear primary/secondary/tertiary ordering? |
| 2   | **Information Architecture** | Is content grouped logically? Can users find what they need?                                    |
| 3   | **Typography**               | Is there a clear type scale? Weight contrast? Readable measure (45-75 characters)?              |
| 4   | **Color & Contrast**         | Intentional palette? WCAG AA contrast? Meaningful color use (not decorative)?                   |
| 5   | **Spatial Design**           | Consistent spacing system? Rhythm variation? Appropriate density for context?                   |
| 6   | **Interaction Design**       | Clear affordances? Hover/focus/active states? Progressive disclosure?                           |
| 7   | **Motion & Animation**       | Purposeful motion? Appropriate timing? respects `prefers-reduced-motion`?                       |
| 8   | **States & Edge Cases**      | Empty states? Loading states? Error states? Long content handling?                              |
| 9   | **Responsive Design**        | Works across breakpoints? Layout adapts (not just scales)? Touch targets?                       |
| 10  | **Distinctiveness**          | Would users remember this UI? Does it have character? Or is it forgettable?                     |

### Step 4: Report Structure

```
## AI Slop Test: [PASS/MARGINAL/FAIL]
[List specific fingerprints found, if any]

## Scores
| Dimension | Score | Summary |
|-----------|-------|---------|
| ... | .../5 | one-line verdict |

## Overall: [X/50]

## What's Working (2-3 highlights)
- ...

## Priority Issues (3-5, ordered by impact)
For each:
- **What**: The specific problem
- **Why:** Impact on user experience
- **Fix**: Concrete fix with code direction
- **Command**: Which command addresses this (e.g., `/i-harden`, `/design`)

## Minor Observations
- ...

## Provocative Questions
Questions that challenge assumptions about the design decisions.
```

## Scoring Guide

| Range | Verdict                                            |
| ----- | -------------------------------------------------- |
| 40-50 | Production-ready with minor polish                 |
| 30-39 | Good foundation, focused improvements needed       |
| 20-29 | Significant issues, redesign parts before shipping |
| 10-19 | Fundamental problems, needs substantial rework     |
| 1-9   | Start over with clear design direction             |

## Enterprise AI Context (Kailash-Specific)

When auditing AI-facing interfaces, also evaluate:

- **Trust signals**: Does the UI build confidence? (See skill/25, Trust Builders)
- **AI state visibility**: Can users see what the AI is doing? (See skill/25, Governors)
- **Wayfinding**: Can new users start without prompt expertise? (See skill/25, Wayfinders)
- **Control**: Can users stop/redirect AI actions? (See skill/25, Controls)

## Related Commands

- `/i-polish` - Fix aesthetic issues identified by this audit (dimensions 1-7)
- `/i-harden` - Address edge cases and production resilience
- `/design` - Load comprehensive design principles
- `/validate` - Project compliance checks

## Agent Teams

Deploy these agents for design audits:

- **uiux-designer** — Deep design analysis and recommendations
- **uiux-designer** — AI-specific interaction pattern evaluation
- **value-auditor** — Enterprise demo value assessment (via Playwright)

## Skill References

- `.claude/skills/23-uiux-design-principles/SKILL.md` - Design principles
- `.claude/skills/23-uiux-design-principles/motion-design.md` - Motion design
- `.claude/skills/23-uiux-design-principles/ux-writing.md` - UX writing
- `.claude/skills/25-ai-interaction-patterns/SKILL.md` - AI interaction patterns
