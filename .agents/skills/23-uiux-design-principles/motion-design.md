# Motion Design Reference

Purposeful animation and motion patterns for enterprise applications. Motion should enhance understanding and provide feedback — not just add decoration.

## Core Principle

> "Every animation should answer: what state changed, and why does the user need to see it happen?"

If the answer is "it looks cool," remove it.

## Timing Reference

| Duration  | Use For                     | Examples                                            |
| --------- | --------------------------- | --------------------------------------------------- |
| 50-100ms  | Instant feedback            | Button press, toggle, checkbox                      |
| 100-200ms | Micro-interactions          | Hover states, tooltips, ripples                     |
| 200-300ms | State changes               | Accordion open/close, tab switch, dropdown          |
| 300-500ms | Layout transitions          | Panel slide, card expand, page transition           |
| 500-800ms | Emphasis                    | Hero entrance, success celebration                  |
| 800ms+    | Rarely — only for narrative | Onboarding walkthroughs, data visualization reveals |

**Rule**: If users trigger an action, response must begin within 100ms. Anything slower feels broken.

## Easing Curves

### Modern Easing (Use These)

```css
/* Standard — most interactions */
transition-timing-function: cubic-bezier(0.2, 0, 0, 1);

/* Emphasized — entrances and key moments */
transition-timing-function: cubic-bezier(0.05, 0.7, 0.1, 1);

/* Deceleration — elements entering the screen */
transition-timing-function: cubic-bezier(0, 0, 0, 1);

/* Acceleration — elements leaving the screen */
transition-timing-function: cubic-bezier(0.3, 0, 1, 1);
```

### Flutter Easing

```dart
// Standard
Curves.easeOutCubic    // Most interactions
Curves.easeInOutCubic  // Symmetrical transitions

// Emphasized
Curves.easeOutExpo     // Hero entrances
Curves.fastOutSlowIn   // Material Design standard

// Avoid
// Curves.bounceOut     — dated, playful feel
// Curves.elasticOut    — distracting in enterprise
```

### Easing Anti-Patterns

- **Linear** — Feels robotic. Never use for UI (acceptable for progress bars).
- **Bounce/elastic** — Dated 2015-era feel. Distracting in enterprise contexts.
- **`ease` (CSS default)** — Too generic. Be intentional with your curve choice.

## Animation Categories

### 1. Entrance Animations

Used when elements appear on screen for the first time.

```css
/* Fade up — standard entrance */
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Keep translate distance small (4-12px). Large distances feel sluggish. */
```

**Stagger Pattern** — When multiple items enter together:

```css
.item {
  animation: fadeUp 300ms cubic-bezier(0.2, 0, 0, 1) both;
}
.item:nth-child(1) {
  animation-delay: 0ms;
}
.item:nth-child(2) {
  animation-delay: 50ms;
}
.item:nth-child(3) {
  animation-delay: 100ms;
}
/* Cap at 5-7 items. Beyond that, use a single group fade. */
/* Stagger delay: 30-80ms between items. */
```

### 2. Micro-Interactions

Feedback for user actions — the most important animation category.

| Interaction       | Animation                                    | Duration |
| ----------------- | -------------------------------------------- | -------- |
| Button hover      | Subtle background shift, slight scale (1.02) | 150ms    |
| Button press      | Scale down (0.97), darken background         | 100ms    |
| Toggle switch     | Slide thumb, color transition                | 200ms    |
| Checkbox          | Check mark draw-in                           | 150ms    |
| Form focus        | Border color + subtle glow                   | 150ms    |
| Tooltip appear    | Fade in + slight scale from origin           | 150ms    |
| Ripple (Material) | Radial expand from touch point               | 300ms    |

### 3. State Transitions

When content changes between states.

```css
/* Accordion expand — animate max-height or use grid technique */
.panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 300ms cubic-bezier(0.2, 0, 0, 1);
}
.panel.open {
  grid-template-rows: 1fr;
}

/* Tab content switch — crossfade */
.tab-content {
  transition:
    opacity 200ms,
    transform 200ms;
}
```

### 4. Loading & Progress

| Type         | Pattern                | When to Use                             |
| ------------ | ---------------------- | --------------------------------------- |
| Skeleton     | Shimmer gradient sweep | Known content structure, <3s wait       |
| Spinner      | Rotating arc           | Unknown duration, <5s wait              |
| Progress bar | Linear fill            | Known duration or percentage            |
| Pulse        | Opacity oscillation    | Background processes, status indicators |

```css
/* Skeleton shimmer */
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
.skeleton {
  background: linear-gradient(
    90deg,
    var(--surface) 25%,
    var(--surface-highlight) 50%,
    var(--surface) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
```

### 5. Page & Route Transitions

Keep page transitions under 300ms. Users expect near-instant navigation.

```css
/* Simple crossfade — safest default */
.page-enter {
  opacity: 0;
}
.page-enter-active {
  opacity: 1;
  transition: opacity 200ms;
}
.page-exit {
  opacity: 1;
}
.page-exit-active {
  opacity: 0;
  transition: opacity 150ms;
}
```

**Avoid**: Slide transitions between peer pages (implies hierarchy that doesn't exist).
**Use**: Slide for drill-down navigation (list → detail) and slide-up for modals/sheets.

## GPU-Accelerated Properties

Only animate these properties for smooth 60fps performance:

| Property             | GPU-Accelerated | Use For                                  |
| -------------------- | :-------------: | ---------------------------------------- |
| `transform`          |       Yes       | Position, scale, rotation                |
| `opacity`            |       Yes       | Fade in/out                              |
| `filter`             |       Yes       | Blur, brightness                         |
| `background-color`   |       No        | Hover states (acceptable, low cost)      |
| `width` / `height`   |       No        | **Avoid** — causes layout reflow         |
| `margin` / `padding` |       No        | **Never animate** — triggers layout      |
| `top` / `left`       |       No        | **Use `transform: translate()` instead** |

```css
/* Bad — triggers layout recalculation */
.card:hover {
  margin-top: -4px;
}

/* Good — GPU-composited, no layout shift */
.card:hover {
  transform: translateY(-4px);
}
```

## Accessibility: prefers-reduced-motion

**Mandatory** — all motion must respect user preference.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

```dart
// Flutter — check platform setting
final reduceMotion = MediaQuery.of(context).disableAnimations;
if (reduceMotion) {
  // Use instant transitions or no animation
}
```

**What to keep in reduced motion**: Functional state changes (color changes, opacity changes for visibility). Remove: decorative motion, stagger delays, entrance animations.

## Motion Anti-Patterns

| Anti-Pattern                | Why It's Bad                                       | Fix                                                                      |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `transition: all 300ms`     | Animates everything including layout properties    | Target specific properties: `transition: opacity 200ms, transform 200ms` |
| Same duration on everything | Feels mechanical and artificial                    | Vary: 150ms for micro, 250ms for state, 400ms for layout                 |
| Bounce/elastic easing       | Dated, distracting in professional contexts        | Use cubic-bezier with subtle deceleration                                |
| Animating on page load      | Delays time-to-interactive, annoys repeat visitors | Only animate above-fold hero on first visit, if at all                   |
| Infinite spinning loaders   | Anxiety-inducing, no progress information          | Use skeleton screens or determinate progress                             |
| Parallax scrolling          | Performance-heavy, causes motion sickness          | Reserve for marketing pages only, never in apps                          |

## Decision Framework

```
Does this element change state?
  NO → No animation needed
  YES →
    Is it user-triggered (click, hover, focus)?
      YES → 100-200ms micro-interaction
      NO →
        Is it a layout change (panel open, tab switch)?
          YES → 200-400ms state transition
          NO →
            Is it entering the viewport for the first time?
              YES → 200-300ms entrance with stagger
              NO → Probably doesn't need animation
```
