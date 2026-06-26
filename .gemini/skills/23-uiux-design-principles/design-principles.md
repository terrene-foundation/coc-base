# UI/UX Design Principles & Guidelines

---

## Top-Down Design Methodology

Design and evaluate in this order -- never bottom-up:

```
Level 1: FRAME/LAYOUT         — Space division, visual hierarchy, information architecture
Level 2: FEATURE COMMUNICATION — Discoverability, action hierarchy, navigation, progressive disclosure
Level 3: COMPONENT EFFECTIVENESS — Widget choice, interaction patterns, feedback, states
Level 4: VISUAL DETAILS        — Colors, shadows, animations, typography refinements
```

---

## Layout & Information Architecture

### Grid & Space Division

- **12-column grid**: Sidebar(3)+Content(9), Sidebar(4)+Content(8), Two-col(6+6), Three-col(4+4+4)
- **70/30 rule**: 70% primary content, 30% secondary UI (nav, filters, chrome)

### Visual Hierarchy Patterns

**F-Pattern** (text-heavy): Users scan horizontally at top, then vertically down left side. Place logo top-left, primary nav top, key content along left edge.

**Z-Pattern** (visual/action-heavy): Top-left(logo) -> Top-right(primary CTA) -> Bottom-left(supporting) -> Bottom-right(secondary CTA).

**Inverted Pyramid**: Most important first. Dashboards: metric cards (top) -> charts (middle) -> data tables (bottom).

### Information Architecture

- **Dashboard-first**: Dashboard(overview) -> List(filtered) -> Detail(single record)
- **Progressive disclosure**: Layer 1(always visible: name, title, primary actions) -> Layer 2(on expand: extended data, secondary actions) -> Layer 3(detail page: full history, tertiary actions)

---

## Typography & Color

### Typography Scale

```
Display: 48px/Bold    — Page titles
H1:      32px/Bold    — Section titles
H2:      24px/SemiBold — Subsection titles
H3:      18px/SemiBold — Card titles
Body:    16px/Regular  — Paragraph text
Small:   14px/Regular  — Labels, captions
Tiny:    12px/Regular  — Helper text
```

**Visual weight**: Importance = Size x Weight x Color Contrast x Position.

### Semantic Color Usage

| Color        | Use For                                         | NOT For                       |
| ------------ | ----------------------------------------------- | ----------------------------- |
| Primary Blue | Primary actions, active state, links            | Decoration, large backgrounds |
| Gray Scale   | Text hierarchy, borders, disabled, backgrounds  | —                             |
| Green        | Positive actions, success, positive metrics     | —                             |
| Orange       | Caution actions, warnings, attention indicators | —                             |
| Red          | Destructive actions, errors, validation errors  | —                             |

### Position Priority

Top-left(highest) -> Top-right -> Center-left -> Center-right -> Bottom-left -> Bottom-right(lowest).

**Proximity (Gestalt)**: Group related items with tight spacing; separate unrelated items with gaps.

---

## Action Hierarchy

### Primary (1 per page)

- Large filled button (48px), brand color, top-right or bottom-right, always visible
- Examples: "+ Add Contact", "Save", "Send"

### Secondary (2-3 per page)

- Medium outlined button (40px), no fill, near primary
- Examples: "Cancel", "Export", "Import"

### Tertiary (unlimited)

- Small text/icon button (32px), no borders, contextual (hover/menus)
- Examples: "Edit" in card menu, "Delete" in overflow

```dart
AppButton.primary(label: 'Add Contact', height: 48, minWidth: 140, fontSize: 16, fontWeight: FontWeight.w600)
AppButton.outlined(label: 'Cancel', height: 40, minWidth: 100, fontSize: 14)
AppButton.text(label: 'Edit', height: 32, fontSize: 14)
```

---

## Search & Filter Patterns

| Pattern                    | When                                | Layout                                 |
| -------------------------- | ----------------------------------- | -------------------------------------- |
| Persistent sidebar (300px) | 5+ filter types, frequent filtering | Sidebar + results side-by-side         |
| Collapsible sidebar        | 3-5 filters, occasional use         | Hidden by default, slide-over on click |
| Horizontal bar             | 1-3 filters, always used            | Compact dropdowns in header row        |

---

## List vs Grid vs Table

| View  | When                                         | Specs                                           |
| ----- | -------------------------------------------- | ----------------------------------------------- |
| Grid  | Visual browsing (faces/photos), 10-100 items | 100-120px cards, 2-4 cols, 16-24px gap          |
| Table | Data comparison, 50-10K items, many fields   | 48-56px rows, 3-8 cols, sortable, sticky header |
| List  | Mobile/narrow, <20 items                     | 64-80px items, full width, dividers             |

---

## Component Patterns

### Card Anatomy

```
[48px Avatar] PRIMARY TEXT (18px bold)
              Secondary text (14px medium)
              Tertiary text (14px gray)
              [Tag] [Tag] [+N] (12px chips, max 2-3)
                                         [Action >]
```

Padding: 16-24px. States: Default(light shadow), Hover(elevated + translate -2px), Pressed(scale 0.98), Selected(2px primary border).

### Empty States

Icon(64-96px) + Primary message(H3, specific) + Secondary message(body, offer solutions) + Primary CTA button. Be specific: "No contacts found for 'Healthcare' in 'North America'" not "No results".

### Loading States

| Pattern                    | When                                                |
| -------------------------- | --------------------------------------------------- |
| Skeleton screens (shimmer) | Initial page load, infinite scroll, data-heavy UI   |
| Spinner                    | Form submission (<3s), quick API calls              |
| Progress bar               | File uploads, bulk operations, multi-step processes |

### Bulk Actions

Default: checkboxes on items. On selection: toolbar replaces header with "N selected [Email All] [Export] [Delete] [Clear]". Keyboard: Cmd+Click(toggle), Shift+Click(range), Cmd+A(all), Escape(clear).

---

## Responsive Design

### Breakpoints

```
Mobile:  < 768px    Tablet: 768-1023    Desktop: 1024-1439    Wide: >= 1440
```

### Layout Changes by Breakpoint

| Element     | Mobile                 | Tablet              | Desktop                   | Wide             |
| ----------- | ---------------------- | ------------------- | ------------------------- | ---------------- |
| Sidebar     | Bottom nav / hamburger | Icon-only (60px)    | Full (240px)              | Full (240px)     |
| Grid cols   | 1 (list)               | 2                   | 3                         | 4                |
| Filters     | Modal bottom sheet     | Collapsible / horiz | Persistent or collapsible | Persistent       |
| Primary CTA | FAB                    | Header compact      | Full-size header          | Full-size header |

---

## Accessibility (WCAG 2.1 AA)

### Color Contrast

- Normal text (<18px): 4.5:1 minimum
- Large text (>=18px or >=14px bold): 3:1 minimum
- Interactive elements: 3:1 minimum

### Keyboard Navigation

- All interactive elements reachable via Tab, logical order
- Visible focus: 2px solid primary, 2px offset
- Enter/Space activates buttons, Escape closes modals

### Screen Reader

- Semantic HTML: `<button>` not `<div onclick>`, `<nav>`, `<main>`
- ARIA: `aria-label` for icon buttons, `aria-live` for dynamic content
- Flutter: `Semantics(label: "Close", child: IconButton(...))`

### Motion

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
  }
}
```

```dart
duration: MediaQuery.of(context).disableAnimations ? Duration.zero : Duration(milliseconds: 200);
```

---

## Design System Structure

```
lib/core/design/
├── colors.dart, typography.dart, spacing.dart, shadows.dart, breakpoints.dart
└── components/ (app_button.dart, app_card.dart, app_input.dart, app_chip.dart, ...)
```

### Component API

```dart
// GOOD: Named constructors, 'is' prefix for booleans, 'on' prefix for callbacks
AppButton.primary(label: 'Save', onPressed: _save, leadingIcon: Icons.save, isLoading: _isSaving, isFullWidth: true)

// BAD: type enum, no named constructors
AppButton(text: 'Save', onClick: _save, type: ButtonType.primary, loading: _isSaving)
```

---

## Common Pitfalls

| Pitfall                                           | Fix                                                        |
| ------------------------------------------------- | ---------------------------------------------------------- |
| Decorative home page ("Welcome!")                 | Functional dashboard: metrics, recent items, quick actions |
| Fixed sidebar wasting space                       | Collapsible, hidden by default                             |
| Primary action hidden (only in Cmd+K)             | Persistent CTA button + keyboard shortcut                  |
| Inverted visual hierarchy (tags bigger than name) | Size = Importance: name 18px bold, tags 12px muted         |
| Low information density (20 items/page)           | 30-50 grid, 100 table, user-toggle density                 |
| No bulk actions                                   | Checkbox selection + bulk toolbar                          |
| Oversized profile avatars (120px)                 | Inline compact: 64px avatar + name + actions same row      |

---

## Decision Trees

### Layout Pattern

```
Frequent filtering -> 5+ types: persistent sidebar | 3-4: collapsible sidebar
Occasional filtering -> 1-3 filters: horizontal bar
No filtering -> <100: single page | 100-1000: paginated grid | 1000+: virtual-scroll table
```

### View Type

```
Visual content (faces/photos) -> 10-100: grid | <20: list
Structured data (many fields) -> sortable table
Mixed -> grid default + table toggle
```

---

## Design Readiness Checklist

- [ ] Primary content occupies 60-70% of space
- [ ] Clear visual hierarchy (size, weight, position)
- [ ] Primary CTA always visible, 1-2 clicks for common tasks
- [ ] Empty states offer solutions, loading matches content structure
- [ ] Color contrast WCAG AA (4.5:1 text), keyboard accessible
- [ ] Typography and spacing use consistent scale
- [ ] Responsive across mobile/tablet/desktop
