# Production Hardening Checklist

Detailed hardening criteria for frontend interfaces. Referenced by `/i-harden` command. Adapted from [Impeccable](https://impeccable.style/) (Apache 2.0).

## 1. Text & Content Resilience

**Overflow Handling**

- [ ] Single-line text uses `text-overflow: ellipsis` / Flutter `overflow: TextOverflow.ellipsis`
- [ ] Multi-line text uses `-webkit-line-clamp` / `maxLines` with overflow
- [ ] Container widths use `min-width` / `max-width` (never only fixed width)
- [ ] Long URLs and unbreakable strings use `overflow-wrap: break-word`

**Content Length Extremes**

- [ ] Test with empty strings (0 characters)
- [ ] Test with very long strings (500+ characters)
- [ ] Test with single very long word (no spaces)
- [ ] Test with special characters (emoji, RTL, CJK, mathematical symbols)
- [ ] Test with HTML entities in user-generated content

**Dynamic Content**

- [ ] Labels that change between languages don't break layout
- [ ] Numbers with different digit counts don't misalign (use tabular figures)
- [ ] Dates in different formats fit their containers (MM/DD/YYYY vs DD.MM.YYYY)

## 2. Internationalization (i18n)

**Text Expansion**

- [ ] German translations (30% longer than English) don't overflow
- [ ] Arabic/Hebrew RTL layout works with logical CSS properties (`margin-inline-start` not `margin-left`)
- [ ] CJK text renders with appropriate line-breaking rules
- [ ] Button text accommodates 50% expansion without breaking

**Formatting**

- [ ] Numbers use `Intl.NumberFormat` / locale-aware formatting
- [ ] Dates use `Intl.DateTimeFormat` / locale-aware formatting
- [ ] Currency symbols position correctly for locale (prefix vs suffix)
- [ ] Pluralization rules handle edge cases (0 items, 1 item, 2 items, 100 items)

**Character Encoding**

- [ ] UTF-8 throughout the stack
- [ ] Emoji render correctly in all text fields
- [ ] Accented characters don't break sorting or searching

## 3. Error States & Recovery

**Network Errors**

- [ ] Offline state shows meaningful message (not blank screen)
- [ ] Slow connection shows loading indicator within 200ms
- [ ] Failed API calls show contextual error with retry option
- [ ] Partial page loads don't leave UI in broken state

**HTTP Status Handling**

| Status | Behavior |
|--------|----------|
| 401 | Redirect to login (not generic error) |
| 403 | Show "insufficient permissions" with guidance |
| 404 | Show "not found" with navigation options |
| 422 | Show field-specific validation errors |
| 429 | Show rate limit message with retry timing |
| 500 | Show generic error with support contact |

**Form Errors**

- [ ] Validation messages appear near the offending field (not just top of form)
- [ ] Invalid fields are visually marked (border + icon + text, not just color)
- [ ] User input is preserved after validation failure (never clear the form)
- [ ] Submit button shows loading state and prevents double-submission

## 4. Edge Cases & Boundary Conditions

**Empty States**

- [ ] Empty list/table shows helpful message explaining what goes here
- [ ] Empty state includes primary action (Add, Create, Import)
- [ ] Empty search results suggest query modifications
- [ ] First-time user sees guidance, not just empty containers

**Loading States**

- [ ] Skeleton screens for known content structure
- [ ] Spinner/progress for unknown duration
- [ ] Estimated time for long operations (>5s)
- [ ] Loading does NOT block other page interactions

**Data Volume**

- [ ] Lists/tables handle 0, 1, 10, 100, 1000, 10000 items
- [ ] Pagination or virtual scrolling for >100 items
- [ ] Search/filter is available when >20 items
- [ ] Bulk actions scale (selecting 1000 items doesn't freeze UI)

**Concurrent Operations**

- [ ] Submit buttons disable after click (prevent double submit)
- [ ] Optimistic UI updates roll back on failure
- [ ] Stale data detection (show "data has changed" refresh prompt)
- [ ] Tab/window deduplication for destructive operations

## 5. Accessibility Resilience

- [ ] 200% browser zoom doesn't break layout
- [ ] Keyboard-only navigation reaches all interactive elements
- [ ] Screen reader announces dynamic content changes (`aria-live`)
- [ ] Focus management after modal close returns to trigger element
- [ ] Touch targets are 44x44px minimum on mobile
- [ ] Reduced motion mode works (`prefers-reduced-motion`)

## 6. Performance Under Stress

- [ ] Images use `loading="lazy"` / lazy loading for below-fold content
- [ ] Large lists use virtual scrolling (not DOM rendering all items)
- [ ] Animations use `transform` and `opacity` only (GPU-accelerated)
- [ ] Event handlers are debounced (search input, scroll, resize)
- [ ] No layout thrashing (read-then-write batching)

## Testing Commands

```bash
# Simulate slow network (Chrome DevTools)
# Network tab -> Throttling -> Slow 3G

# Test with screen reader
# macOS: Cmd+F5 (VoiceOver)

# Test zoom resilience
# Ctrl/Cmd + scroll to 200%

# Test keyboard navigation
# Tab through entire page, verify focus order
```
