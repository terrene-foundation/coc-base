# UX Writing & Microcopy Reference

Clear, concise interface text that helps users accomplish tasks without friction. Every word in a UI should earn its place.

## Core Principles

1. **Be concise** — Remove words that don't add information. "Click the button to submit your form" → "Submit"
2. **Be specific** — "Something went wrong" is useless. "Payment failed — your card was declined" is actionable.
3. **Be human** — Write like a helpful colleague, not a legal document or a robot.
4. **Front-load meaning** — Put the most important word first. Users scan, they don't read.
5. **Use active voice** — "You deleted the file" not "The file was deleted by you"

## Microcopy Patterns

### Buttons & Actions

| Pattern            | Good                       | Bad                          |
| ------------------ | -------------------------- | ---------------------------- |
| Primary action     | "Save changes"             | "Submit" (submit what?)      |
| Destructive action | "Delete project"           | "Delete" (delete what?)      |
| Confirmation       | "Yes, delete project"      | "OK" / "Yes"                 |
| Cancel             | "Cancel" or "Keep editing" | "No" / "Dismiss"             |
| Loading state      | "Saving..."                | "Loading..." (loading what?) |
| Success            | "Changes saved"            | "Success!"                   |

**Rules**:

- Button text = verb + noun: "Add member", "Export report", "Create workspace"
- Destructive buttons repeat the object: "Delete **this project**" not just "Delete"
- Avoid "Click here", "Submit", "OK" — they communicate nothing
- Loading text matches the action: "Sending email..." not "Processing..."

### Error Messages

**Structure**: What happened + Why + What to do next

```
[Icon] [What happened]
[Why it happened — if known and helpful]
[Action to fix it]
```

| Situation  | Good                                                                   | Bad                         |
| ---------- | ---------------------------------------------------------------------- | --------------------------- |
| Validation | "Email address must include @"                                         | "Invalid input"             |
| Permission | "You need admin access to delete users. Contact your workspace owner." | "403 Forbidden"             |
| Network    | "Couldn't connect. Check your internet and try again."                 | "Network error"             |
| Server     | "Something went wrong on our end. We're looking into it."              | "500 Internal Server Error" |
| Not found  | "This page doesn't exist. It may have been moved or deleted."          | "404"                       |
| Rate limit | "Too many requests. Try again in 30 seconds."                          | "Rate limited"              |

**Rules**:

- Never blame the user: "That password is incorrect" not "You entered the wrong password"
- Never show raw error codes to users (log them for debugging)
- Always offer a next step: retry button, contact support, navigate elsewhere
- Inline validation is better than after-submit validation

### Empty States

**Structure**: What goes here + Why it's empty + How to fill it

```
[Illustration — optional, not required]
[What this section shows]
[Why it's currently empty]
[Primary action button]
```

| Context        | Good                                                                            | Bad               |
| -------------- | ------------------------------------------------------------------------------- | ----------------- |
| New account    | "No projects yet. Create your first project to get started." + [Create project] | "No data"         |
| Search results | "No results for 'foobar'. Try a different search term or check your filters."   | "0 results"       |
| Filtered view  | "No contacts match these filters." + [Clear filters]                            | "Nothing to show" |
| Completed work | "All tasks complete. Nice work!"                                                | (empty screen)    |

### Form Labels & Placeholders

**Labels** (always visible, above the field):

- Use sentence case: "Email address" not "EMAIL ADDRESS"
- Be specific: "Work email" not "Email"
- Required fields: mark optional fields with "(optional)" rather than marking required with \*

**Placeholders** (inside the field, disappears on focus):

- Show format examples: "name@company.com"
- Never use as the only label (disappears when typing)
- Don't repeat the label: if label says "Email", placeholder shouldn't say "Enter your email"

**Help text** (below the field):

- Explain constraints: "Must be at least 8 characters with one number"
- Show before errors, not after: prevent errors rather than punishing them

| Element     | Good                            | Bad                            |
| ----------- | ------------------------------- | ------------------------------ |
| Label       | "Company name"                  | "Name" (ambiguous)             |
| Placeholder | "Acme Corp"                     | "Enter your company name here" |
| Help text   | "This appears on your invoices" | "Required field"               |

### Confirmation Dialogs

**Structure**: Clear question + Consequences + Two distinct actions

```
[Heading: verb + noun]
[What will happen, including irreversible consequences]
[Cancel button]  [Confirm button matching the heading verb]
```

**Good example**:

```
Delete "Q4 Report"?
This will permanently delete the file and all its versions.
This action cannot be undone.

[Cancel]  [Delete file]
```

**Bad example**:

```
Are you sure?
Do you want to continue?

[No]  [Yes]
```

**Rules**:

- Heading states the action, not "Are you sure?"
- Explain consequences explicitly (especially if irreversible)
- Confirm button text matches the action: "Delete file" not "OK"
- Don't use confirmation for reversible actions (use undo instead)

### Tooltips & Contextual Help

- Keep under 150 characters (1-2 sentences max)
- Explain why, not what (the label explains what)
- Don't repeat information visible on screen
- Use for power-user features, not basic functionality
- Show on hover (desktop) and long-press (mobile)

| Good                                                      | Bad                      |
| --------------------------------------------------------- | ------------------------ |
| "Members with this role can edit but not delete projects" | "Click to set role"      |
| "Sent to all workspace members every Monday at 9am"       | "Weekly digest settings" |

### Status & Feedback Messages

**Toast/Snackbar messages**: Action confirmation that auto-dismiss.

- Keep to one line: "Contact saved" / "Email sent to 5 recipients"
- Include undo when applicable: "Message archived" [Undo]
- Auto-dismiss after 4-6 seconds (longer for important info)

**Banner messages**: Persistent information that requires attention.

- Info: "New feature: You can now export reports as PDF"
- Warning: "Your trial ends in 3 days. Upgrade to keep your data."
- Error: "Billing failed. Update your payment method to avoid service interruption."
- Success: "Account verified. You now have access to all features."

### Numbers & Data

- Use commas for thousands: "1,234" not "1234"
- Round appropriately: "$1.2M" not "$1,234,567.89" in summaries
- Use relative time where helpful: "2 hours ago" not "2026-02-28T14:32:00Z"
- Show exact values on hover: tooltip with "February 28, 2026 at 2:32 PM"
- Use units: "47 MB" not "47" / "3 min read" not "3"

## Tone Guidelines for Enterprise

| Context             | Tone              | Example                                             |
| ------------------- | ----------------- | --------------------------------------------------- |
| Onboarding          | Warm, encouraging | "Let's get you set up. This takes about 2 minutes." |
| Normal operations   | Clear, neutral    | "3 contacts updated."                               |
| Errors              | Helpful, calm     | "We couldn't process that. Here's what to try."     |
| Destructive actions | Direct, serious   | "This will permanently delete all project data."    |
| Success             | Brief, positive   | "Done." / "Saved." / "Published."                   |
| Empty states        | Helpful, inviting | "No results yet. Start by adding your first entry." |

**Never**:

- Use exclamation marks in error messages
- Use jargon (HTTP codes, technical terms) in user-facing text
- Use "please" excessively (one "please" per flow maximum)
- Use ALL CAPS for emphasis (use bold or size instead)
- Use "click" — say "select" (works for mouse, touch, and keyboard)

## Checklist

For every piece of UI text, verify:

- [ ] Would a new user understand this without context?
- [ ] Is there a shorter way to say this without losing meaning?
- [ ] Does the error message tell users how to fix it?
- [ ] Do button labels describe the action and the object?
- [ ] Is the tone appropriate for the situation (error vs success)?
- [ ] Does it work for screen readers (no "click here", meaningful link text)?
