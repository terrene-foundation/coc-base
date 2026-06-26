---
name: i-polish
description: "Visual refinement workflow for frontend artifacts — typography, spacing, motion."
---

# /i-polish - Visual Refinement Workflow

## Purpose

Systematically fix aesthetic and visual quality issues identified by `/i-audit`. Takes audit findings in dimensions 1-7 and applies concrete fixes to typography, color, spacing, interaction, and motion.

Part of the Impeccable pipeline: **`/i-audit` (diagnose) → `/i-polish` (refine) → `/i-harden` (fortify)**

## Usage

| Command                | Action                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| `/i-polish`            | Full visual refinement pass on current file/component                         |
| `/i-polish $ARGUMENTS` | Focused refinement on a specific area (e.g., `typography`, `color`, `motion`) |

## Refinement Process

### Step 1: Context Gathering (Mandatory)

Before refining, gather:

1. **What framework?** (React, Flutter, vanilla HTML/CSS)
2. **What component/page?** (Read the target files)
3. **Existing design system?** (Check for design tokens, theme files)
4. **Audit results?** (Check if `/i-audit` was run — use those scores to prioritize)

If no audit exists, run `/i-audit` first to establish a baseline.

### Step 2: Systematic Refinement (7 Areas)

Work through each area, prioritizing by audit score (lowest scores first):

**1. Visual Hierarchy**

- Apply size/weight/position formula: primary > secondary > tertiary
- Ensure important elements draw attention first
- Fix competing focal points

**2. Information Architecture**

- Apply 70/30 rule (core content vs. supporting)
- Implement progressive disclosure for complexity
- Group related elements logically

**3. Typography**

- Establish modular type scale (e.g., 1.25 ratio: 12, 15, 19, 24, 30, 37)
- Create weight contrast (not `font-weight: 600` on everything)
- Optimize line-height per context (headings: 1.1-1.3, body: 1.5-1.7)
- Set measure to 45-75 characters for readability

**4. Color & Contrast**

- Apply semantic color usage (meaning, not decoration)
- Verify WCAG AA contrast ratios (4.5:1 text, 3:1 large text)
- Remove decorative gradients and random accent colors
- Establish intentional palette with purpose for each color

**5. Spatial Design**

- Establish spacing scale (4px/8px base unit)
- Create rhythm variation (not uniform spacing everywhere)
- Match density to context (data-heavy = denser, marketing = spacious)
- Fix shadow hierarchy (cards < dropdowns < modals < toasts)

**6. Interaction Design**

- Add/fix hover, focus, active, disabled states
- Ensure clear affordances (clickable things look clickable)
- Implement progressive disclosure where appropriate
- Verify keyboard navigation and focus indicators

**7. Motion & Animation**

- Target specific CSS properties (not `transition-all`)
- Vary timing by purpose (micro: 100-200ms, state: 200-400ms, emphasis: 400-700ms)
- Use appropriate easing (ease-out for entering, ease-in for exiting)
- Respect `prefers-reduced-motion`
- Remove purposeless animations

### Step 3: AI Slop Remediation

If `/i-audit` flagged AI slop fingerprints, systematically remove each one:

- Replace Tailwind default colors with intentional palette
- Break uniform spacing with rhythm variation
- Replace `rounded-2xl` everywhere with varied border-radius by element type
- Replace `shadow-lg` everywhere with shadow hierarchy
- Replace `transition-all` with targeted property transitions
- Add asymmetry and layout variation to break card-grid monotony

### Step 4: UX Writing Pass

Apply microcopy refinements:

- Button labels: specific verbs ("Save changes" not "Submit")
- Error messages: what happened + how to fix it
- Empty states: explain why empty + provide action
- Loading states: set expectations, show progress

### Step 5: Report

```
## Polish Summary

### Changes Made
| Area | Before | After | Files |
|------|--------|-------|-------|
| ... | ... | ... | ... |

### Remaining Issues
[Any issues that need `/i-harden` or deeper redesign]

### Next Step
Run `/i-harden` for production resilience, or `/i-audit` to verify improvements.
```

## Agent Teams

Deploy these agents for visual refinement:

- **uiux-designer** — Design analysis, typography systems, color theory, spacing optimization
- **react-specialist** — React implementation of refinements
- **flutter-specialist** — Flutter implementation of refinements (if applicable)

## Related Commands

- `/i-audit` - Diagnose visual quality issues (run first)
- `/i-harden` - Fortify for production resilience (run after)
- `/design` - Load comprehensive design principles

## Skill References

- `.claude/skills/23-uiux-design-principles/design-principles.md` - Design principles
- `.claude/skills/23-uiux-design-principles/motion-design.md` - Motion design
- `.claude/skills/23-uiux-design-principles/ux-writing.md` - UX writing
