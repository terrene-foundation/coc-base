# AI Interaction Patterns Reference

Based on [Shape of AI](https://www.shapeof.ai) by Emily Campbell (CC-BY-NC-SA), extended for Kailash SDK.

---

## 1. WAYFINDERS — Help users construct their first prompt

### Gallery

Collections of example generations showing what's possible. Variations: Curated, Community, Dynamic.

- Provide previews, categories, filters for scanning
- Make examples actionable: one-click remix with visible prompt/parameters
- Expose metadata (prompts, models, styles) for reverse-engineering

### Suggestions

3-5 prompt options for capability discovery and momentum. Forms: Static, Contextual, Adaptive.

- Clicking MUST run the prompt (editable or direct)
- Display 3-6 options ordered by relevance
- Confirm suggestions triggering data access or heavy compute

### Templates

Structured prompt scaffolds for complex/recurring tasks.

- Organize by use case (not AI capability); show output preview; allow customization

### Follow-ups

Prompts/actions to refine or extend interaction. Forms: Conversation extenders, Clarifying questions, Depth probes, Comparisons, Action nudges.

- Ground in context (not generic); mix "zoom in" with "zoom out"; visually separate from output

### Initial CTA

Entry-point design: position galleries/suggestions/templates. Never show an empty text box.

### Nudges

Contextual guidance for better prompts. One nudge at a time, specific not generic.

### Prompt Details

Expose parameters/prompts behind content. Enable one-click prompt copying.

### Randomize

"Surprise me" secondary action. Show what was randomized for learning.

---

## 2. PROMPT ACTIONS — Actions users direct AI to complete

### Open Input

Natural language dialogue. Contexts: Chat box, Inline composer, Command-style, Side panel.

- Set clear default scope; provide templates/guidance; maintain parameter options

### Inline Action

Targeted edits on selections. Keep scope tight; show before/after preview.

### Chained Action

Multi-step sequential tasks. Show chain visually; allow editing intermediate results.

### Regenerate

Re-run with variations. Never overwrite original; show as new versions.

### Content Modification Family

| Action      | Purpose                             |
| ----------- | ----------------------------------- |
| Transform   | Change format/structure             |
| Restyle     | Change tone/style                   |
| Expand      | Elaborate with detail               |
| Summary     | Condense to key points              |
| Synthesis   | Combine multiple sources            |
| Restructure | Reorganize without changing content |

### Describe

Generate text/data from visual or audio input.

### Auto-fill

AI-populated form fields. Always show what was auto-filled; mark visually.

### Madlibs

Fill-in-the-blank prompt construction. Keep blanks to 3-5 fields max.

### Inpainting

Selective region-based editing for visual content.

---

## 3. TUNERS — Adjust context, weights, and input details

| Pattern                 | Purpose                             | Key Guidance                                                              |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| **Attachments**         | File upload/context management      | Show processing status, context limits, relevance scores                  |
| **Connectors**          | External data source integration    | Show connection status; per-source permissions                            |
| **Model Management**    | Model selection/switching           | Signal routing changes; show capabilities/costs; never silently downgrade |
| **Parameters**          | Generation settings (temp, length)  | Hide behind "Advanced" for novices; show impact preview                   |
| **Prompt Enhancer**     | Auto-improve prompts pre-submission | Show original vs enhanced side-by-side                                    |
| **Modes**               | Task-specific behavior profiles     | Make active mode visible; show behavior effects                           |
| **Preset/Saved Styles** | Parameter combinations for reuse    | Organize by use case; one-click apply                                     |
| **Voice and Tone**      | AI personality config               | Separate from content params; combine with Memory                         |
| **Filters**             | Narrow input/output scope           | Date range, source type, content category                                 |

---

## 4. GOVERNORS — Human oversight and agency

### Action Plan

AI outlines steps before execution. Modes: Advisory (inform), Contractual (require approval).
Variations: Step Lists, Execution Previews, Content Outlines, Adaptive Plans.

- Display BEFORE consuming resources; keep readable; enable modification without regeneration
- MUST: execution matches plan; unexplained deviations erode trust

### Stream of Thought

Visible trace: plans formed, tools called, decisions made.

- Show plan before acting; separate plan/execution/evidence views
- State per step: queued, running, waiting, error, retried, completed

### Controls

| Control      | Purpose                               |
| ------------ | ------------------------------------- |
| Stop         | End generation mid-stream (universal) |
| Pause        | Halt without losing progress          |
| Fast-forward | Confirm continued generation          |
| Play/Submit  | Initiate new tasks                    |

Queue pattern: let users stack tasks without interrupting current work.

### Draft Mode

Fewer details before committing to full run. Variations: Explicit, Implicit, Model Routing.

- Users MUST NEVER be surprised by lower quality
- Specify what's reduced alongside speed/cost impact
- Preserve seeds/prompts between draft and final

### Branches

Divergent "what if" exploration paths. Visualize as tree; allow merging back.

### Variations

Multiple outputs from same prompt. Methods: Branched (grid), Convergent (select one), Preset (pre-applied mods).

- NEVER overwrite original without confirmation

### Citations

Connect output to source material. Variations: Inline Highlights, Direct Quotations, Multi-Source References, Lightweight Links.

- Match citation specificity to context; place where users expect them

### Verification

Confirmation gates before irreversible actions. Show exactly what happens; make cancel the default.

### Memory

Retain info across sessions. Scopes: Global, Scoped (workspace), Ephemeral (session-only).

- MUST NOT be a black box; show when memories added; allow management
- Support context-switching (personal vs professional)

### Cost Estimates

Show estimated cost BEFORE execution. Compare alternatives (draft vs final, model A vs B).

---

## 5. TRUST BUILDERS — Confidence in ethics, accuracy, trustworthiness

| Pattern            | Purpose                                | Key Rule                                                                        |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------- |
| **Disclosure**     | Label AI content                       | Name actor consistently; label actions not features; visual differentiation     |
| **Caveat**         | Remind AI may err                      | Never sole safety mechanism; targeted notes outperform generic warnings         |
| **Consent**        | Permission before data sharing         | Opt-in standard; differentiate recording/training/sharing; enable reversibility |
| **Data Ownership** | Data storage/use/deletion transparency | Clear toggles per data use; enable export and deletion                          |
| **Watermark**      | Mark AI-generated media                | Use C2PA standards                                                              |
| **Incognito Mode** | Non-persistent sessions                | Clear indicator throughout; prevent accidental capture                          |

---

## 6. IDENTIFIERS — Distinct AI qualities

| Pattern         | Purpose                     | Key Guidance                                                                        |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| **Avatar**      | Visual/voice AI form        | Strategic visibility; unambiguous state indicators; avoid deceptive photorealism    |
| **Personality** | Behavioral characteristics  | Guard against sycophancy; signal routing/model changes; design attachment off-ramps |
| **Name**        | Naming strategy             | Human names imply human capability; abstract names set appropriate expectations     |
| **Color**       | Brand identity + state      | Reserve specific colors for AI state; don't reuse for other UI                      |
| **Iconography** | AI-specific visual language | Consistent across product; use at decision points only                              |

---

## Pattern Interaction Map

```
ONBOARDING:   Initial CTA -> Gallery/Suggestions -> Open Input -> Follow-ups
GENERATION:   Open Input + Parameters -> Action Plan -> Stream of Thought -> Controls -> Variations
TRUST:        Disclosure -> Citations -> Caveat -> Verification
PERSONALIZE:  Memory + Voice & Tone + Saved Styles -> Adaptive Suggestions
AGENTIC:      Open Input -> Action Plan -> Stream of Thought -> Controls -> Verification -> Citations
```

## Kailash Implementation Notes

- **Kaizen agents**: AI backend; Signature system maps to Tuner parameters
- **Nexus**: Multi-channel frontend (API+CLI+MCP)
- **DataFlow**: Conversation history, memory, citations, preferences
- **Interactive Widgets (Skill 20)**: AI response rendering
- **Conversation UX (Skill 22)**: Thread management, branching

These are DESIGN patterns (WHAT/WHY), not implementation patterns (HOW). Pair with framework specialists for implementation.

---

**Source**: Shape of AI (shapeof.ai) by Emily Campbell. Licensed CC-BY-NC-SA.
**Version**: 1.0 - 2026-02-24
