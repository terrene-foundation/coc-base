---
name: i-harden
description: "Production hardening for frontend — performance, accessibility, observability."
---

# /i-harden - Production Hardening for Frontend

## Purpose

Prepare frontend interfaces for real-world usage by stress-testing against imperfect conditions: long text, missing data, slow networks, diverse languages, and unconventional inputs.

Adapted from [Impeccable](https://impeccable.style/) (Apache 2.0), enhanced for enterprise contexts.

## Usage

| Command                | Action                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `/i-harden`            | Full production hardening audit of current file/component                           |
| `/i-harden $ARGUMENTS` | Focused hardening on a specific area (e.g., `text`, `i18n`, `errors`, `edge-cases`) |

## Philosophy

> "Designs that only work with perfect data aren't production-ready."

Enterprise users have long names, mixed-language content, slow connections, and unexpected input. Hardened interfaces handle all of it gracefully.

## Workflow

### Step 1: Load Hardening Checklist

Read `skills/23-uiux-design-principles/production-hardening.md` for the full 6-category checklist covering:

1. **Text & Content Resilience** -- overflow, length extremes, dynamic content
2. **Internationalization** -- text expansion, formatting, character encoding
3. **Error States & Recovery** -- network errors, HTTP status handling, form errors
4. **Edge Cases & Boundary** -- empty states, loading states, data volume, concurrency
5. **Accessibility Resilience** -- zoom, keyboard nav, screen reader, touch targets
6. **Performance Under Stress** -- lazy loading, virtual scrolling, debouncing

If `$ARGUMENTS` specifies a focus area, evaluate only that category. Otherwise, evaluate all six.

### Step 2: Evaluate Current Code

For each category in scope:

1. Read the target component/page files
2. Check each item against the detailed checklist
3. Note PASS, FAIL, or N/A for each item
4. For FAILs, draft a concrete fix with code direction

### Step 3: Generate Report

```
## Hardening Assessment

### Resilience Score: [X/6 categories passing]

| Category | Status | Critical Issues |
|----------|--------|-----------------|
| Text & Content | PASS/FAIL | ... |
| Internationalization | PASS/FAIL | ... |
| Error States | PASS/FAIL | ... |
| Edge Cases | PASS/FAIL | ... |
| Accessibility | PASS/FAIL | ... |
| Performance | PASS/FAIL | ... |

### Critical Fixes (must fix before shipping)
1. ...

### Important Fixes (should fix soon)
1. ...

### Nice-to-Have (polish)
1. ...
```

### Step 4: Implement Fixes

After presenting the report, implement critical and important fixes. Delegate to the appropriate framework specialist.

## Related Commands

- `/i-audit` - Run design audit before hardening
- `/design` - Design principles and responsive patterns
- `/test` - Testing strategies for frontend

## Agent Teams

- **uiux-designer** -- Design-level edge case decisions
- **react-specialist** -- React implementation of hardening
- **flutter-specialist** -- Flutter implementation of hardening
- **testing-specialist** -- Creating hardening test suites

## Skill References

- `skills/23-uiux-design-principles/production-hardening.md` -- Full 6-category checklist with detailed checks
- `skills/23-uiux-design-principles/SKILL.md` -- Design principles (states, responsive)
- `skills/12-testing-strategies/SKILL.md` -- Testing patterns
