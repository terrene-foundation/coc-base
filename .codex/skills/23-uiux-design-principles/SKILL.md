---
name: uiux-design-principles
description: "UI/UX design for enterprise apps — layout, hierarchy, accessibility, design systems."
---

# UI/UX Design Principles

Framework-agnostic design principles and patterns for building professional enterprise applications. This skill is **CRITICAL** for all frontend work and should be invoked proactively before any UI implementation.

## Overview

This skill provides:

- Top-down design methodology (layout → features → components → details)
- Layout and information architecture patterns
- Visual hierarchy principles (F-pattern, Z-pattern, inverted pyramid)
- Enterprise UX patterns (action hierarchy, search & filter, bulk actions)
- Component design guidelines (cards, buttons, empty states, loading states)
- Responsive design patterns for all breakpoints
- Accessibility standards (WCAG 2.1 AA compliance)
- Design system principles and naming conventions
- Common pitfalls and solutions

## Reference Documentation

### Core Principles

- **[design-principles](design-principles.md)** - Complete UI/UX design principles and guidelines
  - Top-down design methodology
  - Layout & information architecture
  - Visual hierarchy principles
  - Enterprise UX patterns
  - Component design guidelines
  - Responsive design patterns
  - Accessibility standards
  - Design system principles
  - Common pitfalls & solutions

### Motion Design

- **[motion-design](motion-design.md)** - Animation timing, easing curves, and motion patterns
  - Timing reference (50ms-800ms+ by interaction type)
  - Modern easing curves (CSS + Flutter)
  - Animation categories (entrance, micro-interaction, state, loading, page)
  - GPU-accelerated properties checklist
  - `prefers-reduced-motion` accessibility (mandatory)
  - Motion anti-patterns and decision framework

### Production Hardening

- **[production-hardening](production-hardening.md)** - Frontend production hardening checklist
  - Text & content resilience (overflow, length extremes, dynamic content)
  - Internationalization (text expansion, formatting, encoding)
  - Error states & recovery (network, HTTP status, form errors)
  - Edge cases & boundary conditions (empty, loading, data volume, concurrency)
  - Accessibility resilience (zoom, keyboard, screen reader, touch)
  - Performance under stress (lazy loading, virtual scrolling, debouncing)

### UX Writing & Microcopy

- **[ux-writing](ux-writing.md)** - Interface text patterns for enterprise applications
  - Button & action label patterns (verb + noun)
  - Error message structure (what + why + fix)
  - Empty state copy (what goes here + why empty + how to fill)
  - Form labels, placeholders, and help text
  - Confirmation dialog structure
  - Toast/banner message patterns
  - Enterprise tone guidelines

## Quick Patterns

### Top-Down Design Order (ALWAYS Follow This)

```
LEVEL 1: FRAME/LAYOUT (Highest Priority)
  ↓ Space division, visual hierarchy, information architecture
LEVEL 2: FEATURE COMMUNICATION
  ↓ Discoverability, action hierarchy, navigation
LEVEL 3: COMPONENT EFFECTIVENESS
  ↓ Widget appropriateness, interaction patterns, feedback
LEVEL 4: VISUAL DETAILS (Lowest Priority)
  → Colors, shadows, animations, typography refinements
```

### The 70/30 Rule

- 70% of space = primary content (what user came to see/do)
- 30% of space = secondary UI (navigation, filters, chrome)

### Action Hierarchy

| Type      | Size | Style    | Position     | Use                           |
| --------- | ---- | -------- | ------------ | ----------------------------- |
| Primary   | 48px | Filled   | Top-right    | 1 per page (Save, Add)        |
| Secondary | 40px | Outlined | Near primary | 2-3 per page (Cancel, Export) |
| Tertiary  | 32px | Text     | Contextual   | Unlimited (Edit, View)        |

### View Type Decision

| Data Type                      | Recommended View       |
| ------------------------------ | ---------------------- |
| Visual content (faces, photos) | Grid (2-4 columns)     |
| Structured data (many fields)  | Table (sortable)       |
| Mobile/narrow screens          | List (single column)   |
| Mixed visual + data            | Grid with Table toggle |

## CRITICAL Gotchas

| Rule                                  | Why                                                 |
| ------------------------------------- | --------------------------------------------------- |
| ❌ NEVER design bottom-up             | Perfecting shadows on misplaced cards wastes effort |
| ✅ ALWAYS start with layout           | Solve fundamental usability issues first            |
| ❌ NEVER hide primary actions         | Users must find main CTA without keyboard shortcuts |
| ✅ ALWAYS have persistent primary CTA | Visible button + keyboard shortcut for power users  |
| ❌ NEVER use color as sole indicator  | Accessibility requires icons + text for status      |
| ✅ ALWAYS test on all breakpoints     | Mobile, tablet, desktop must all work               |

## When to Use This Skill

Use this skill **PROACTIVELY** when:

- Starting ANY frontend feature or page design
- Reviewing or auditing existing UI/UX
- Making layout or spacing decisions
- Designing navigation or information architecture
- Creating or extending design systems
- Implementing responsive layouts
- Ensuring accessibility compliance
- Resolving visual design problems

## Related Skills

- **[25-ai-interaction-patterns](../25-ai-interaction-patterns/SKILL.md)** - AI UX patterns

## Support

For UI/UX design questions, invoke:

- `uiux-designer` - Design analysis and recommendations
- `react-specialist` - Implementation guidance
- `flutter-specialist` - Flutter/Material Design implementation
- `react-specialist` - React component implementation
