---
priority: 10
scope: path-scoped
paths:
  - "**/.claude/hooks/**"
  - "**/.claude/variants/**/hooks/**"
  - "**/.claude/settings.json"
---

# Hook Event Selection — The Event Is A Deliberated Choice

<!-- slot:neutral-body -->

A hook's EVENT and MATCHER decide whether it can see anything at all. `SessionStart` is the easiest place to make a hook fire, which is exactly why it is the default a detector drifts into — and a detector registered there runs BEFORE the work it inspects exists. It passes every session, forever, and reads as enforcement. That is a silent fail-open with no error to see, the same class `reconcile-settings-hooks.mjs` exists to catch one layer down.

Sibling of `hook-output-discipline.md`, which governs what a hook EMITS once it fires; this rule governs WHERE it fires. Pairs with `cc-artifacts.md` Rule 7 (timeout fallback) and MUST NOT § "No semantic analysis in hooks".

## The Discrimination Test

> **Does the subject this hook reads EXIST at the moment this event fires?**

This is the whole rule. `SessionStart` is CORRECT when the subject is the session itself or durable repo state — both exist before the first tool call. `SessionStart` is WRONG when the subject is produced BY the session, because there is nothing to read yet.

| Class          | Subject                                                | Correct home                                                                             |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `lifecycle`    | the session / compaction / turn boundary itself        | `SessionStart` · `SessionEnd` · `PreCompact` · `Stop`                                    |
| `telemetry`    | that an event occurred; records, never gates           | wherever the event is; `matcher: "*"` legitimate                                          |
| `guard`        | one specific ACTION, at the boundary attempting it     | `PreToolUse` / `PostToolUse` ONLY, with a matcher naming ONLY the tools that perform it   |
| `verification` | a property of work ALREADY PRODUCED                    | gate-time (`/redteam`, `/release`, `/deploy`) or `PostToolUse` scoped to the producing tool |

A hook reading `posture.json`, `settings.json`, the roster, or the git worktree at `SessionStart` is `lifecycle` — that state is on disk before the session starts, so the test is satisfied. A hook checking whether THIS session's edits hold an invariant is `verification` and has nothing to read at `SessionStart`.

**Class tracks WHEN the subject exists, not how protective the hook is.** `guard` and `verification` are the two NARROW classes: each is defined by the one action or artifact it acts on, so each needs a `PreToolUse`/`PostToolUse` matcher naming that tool. Neither is available at `SessionStart` / `SessionEnd` / `Stop` / `PreCompact`, which carry no tool axis. A protective hook at one of those events is `lifecycle` — `settings-deny-drift-guard.js` self-heals `settings.json` at `SessionStart` and is `lifecycle`, not `guard`, however guard-like its purpose. Calling it `guard` would claim a matcher the event cannot carry.

## MUST Rules

### 1. Every Hook Registration Declares Its Event, Matcher, Class, And Rationale

Every hook registered in `settings.json` MUST carry one `@hook-event:` header marker per registration, in the form `@hook-event: <Event>[:<matcher>] (<class>) — <rationale>`. `<class>` MUST be one of `lifecycle` / `telemetry` / `guard` / `verification`; `<rationale>` MUST be non-empty and state why THAT event can see the subject.

```javascript
// DO — one marker per registration; the rationale names the subject
/**
 * @hook-event: SessionStart (lifecycle) — reads posture.json, which is on disk
 *   before the first tool call; the session boundary IS the subject.
 * @hook-event: PreToolUse:Bash (guard) — refuses a destructive command at the
 *   boundary that would run it; Bash is the only tool that can.
 */

// DO NOT — registered, undeclared; the event was never a decision anyone made
/** Hook: check-the-thing. Fires at SessionStart. */
```

**Why:** An undeclared event is an event nobody chose — the author wired the hook where hooks are easy to wire and the reviewer has nothing to disagree with. The marker converts the event from a default into a claim a reviewer and a validator can both check.

### 2. A `verification` Hook MUST NOT Be Registered At `SessionStart`

A hook whose subject is produced BY the session MUST be homed where that subject exists: the gate that runs after production (`/redteam`, `/release`, `/deploy`), or the `PostToolUse` boundary of the tool that produces it. Registering it at `SessionStart` is BLOCKED.

```javascript
// DO — the artifact exists by the time the producing tool has run
/** @hook-event: PostToolUse:Edit|Write (verification) — the edited file is on
 *   disk when this fires, so the invariant has something to hold against. */

// DO NOT — fires before the session has produced anything to verify
/** @hook-event: SessionStart (verification) — checks this session's edits. */
```

**BLOCKED rationalizations:**

- "SessionStart is where the other hooks are"
- "It needs to run once per session, so SessionStart is the once-per-session event"
- "It will catch it on the NEXT session"
- "PostToolUse fires too often; SessionStart is cheaper"
- "There is no gate-time hook event, so SessionStart is the closest thing"
- "It's advisory anyway, so the timing doesn't matter"
- "It passed in testing" (it passes unconditionally — that IS the defect)

**Why:** A verification detector at `SessionStart` inspects a tree the session has not touched yet, so it returns clean on every run whether or not the invariant holds; every rule citing it as its detection mechanism then over-claims enforcement that was never armed. "It will catch it next session" is false whenever the next session is a fresh clone, a CI run, or never.

### 3. Narrow Classes Need A Tool Axis And A Narrow Matcher

A `*` matcher fires the hook on EVERY tool call and charges its startup to all of them — and an OMITTED matcher is not narrower, it is the widest of all. Only `lifecycle` and `telemetry` MAY claim `*` or no matcher; their subject genuinely is "any tool call" or the boundary itself. A `guard` or `verification` hook MUST (a) sit at `PreToolUse`/`PostToolUse`, the only events with a tool axis, and (b) name the tools that can actually perform or produce the thing it inspects.

```javascript
// DO — a heartbeat's subject IS every tool call
/** @hook-event: PreToolUse:* (telemetry) — records liveness per tool call. */

// DO NOT — a guard on writes, charged to Read, Grep, Glob, WebFetch, Task…
/** @hook-event: PreToolUse:* (guard) — blocks writes outside the worktree. */
//   ↑ narrow to Edit|Write|NotebookEdit; no other tool can write.

// DO NOT — matcher OMITTED, which is wider than `*`, not narrower
/** @hook-event: PreToolUse (guard) — blocks writes outside the worktree. */

// DO NOT — a narrow class at an event with no tool axis (use `lifecycle`)
/** @hook-event: SessionStart (guard) — repairs settings.json. */
```

**BLOCKED rationalizations:**

- "`*` is safer — we might miss a tool"
- "Listing the tools means maintaining the list"
- "The hook returns early for irrelevant tools, so the cost is near-zero"
- "A new mutation tool would silently escape a narrow matcher" (the SSOT extension path is `hooks/lib/tool-classes.js::MUTATION_TOOLS` per `cc-artifacts.md` Rule 8)
- "Leaving the matcher off isn't a wildcard, so the narrowing rule doesn't apply"
- "It's protective, so it's a guard wherever it runs"

**Why:** A `*` (or omitted) matcher pays hook-process startup on every Read, Grep and Glob in the session for a check that can only ever fire on a mutation, and it hides the author's actual claim about which tools matter. Omission is the cheaper bypass — it reaches the same blast radius by writing less — so absent, empty and `*` are one case. Narrowing makes the claim explicit and reviewable; the SSOT tool-class Set — not a wildcard — is the defense against a future tool escaping.

### 4. The Declared Marker MUST Agree With `settings.json`

The set of `(event, matcher)` pairs declared in a hook's `@hook-event:` markers MUST equal the set `settings.json` registers for that hook. Re-homing a hook in `settings.json` without updating its marker (or the reverse) is BLOCKED.

```javascript
// DO — re-home the registration and the marker in the same change
// settings.json: SessionStart → PostToolUse:Edit|Write
/** @hook-event: PostToolUse:Edit|Write (verification) — … */

// DO NOT — registration moved, marker left behind; the stated rationale now
//   describes an event the hook is no longer registered at.
```

**Why:** A marker that disagrees with the registration is worse than no marker — it is a rationale for a wiring that no longer exists, and a reviewer reading it will approve the event the hook does NOT fire at. Set-equality is what makes the declaration a durable lock rather than a one-time comment.

## MUST NOT

- Choose a hook's event by where other hooks happen to be registered, or by which event is easiest to make fire.

**Why:** Both are selection procedures that never consult the subject; they are exactly how a detector lands at `SessionStart` and reads as enforcement while checking nothing.

- Cite a hook as a rule's `Detection mechanism` without confirming its registered event fires after the subject exists.

**Why:** The Wiring's detection claim is the only thing a downstream reader has; a claim naming an event that cannot see the subject over-claims enforcement, which is strictly worse than declaring Phase-2 deferred.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (cc-architect at `/codify` + reviewer at `/redteam` confirm each hook registration's declared class matches what the hook actually inspects, and that a rule citing a hook as its detection mechanism names an event that can see the subject); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — whether a check's subject exists at an event is judgment-bearing over the hook's semantics, with no tool-call-time signal. The mechanical half is a `validate-emit.mjs` check whose findings are STRUCTURAL (marker-vocabulary membership, declared-vs-registered set equality, a `verification` token co-occurring with the `SessionStart` event) and therefore MAY block `/sync`; the SEMANTIC half — whether a declared class is the RIGHT class — is deliberately NOT mechanized and stays gate-review-only.
- **Grace period:** 7 days from rule landing (2026-08-01 → 2026-08-08).
- **Cumulative posture impact:** same-class violations (a hook registered at an event that cannot see its subject; a `*` matcher on a `guard`/`verification` hook; a marker disagreeing with `settings.json`) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key. Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8: the mechanical half already blocks `/sync` on the structural arm, so the residual judgment arm does not warrant an instant-drop key, and minting one would drag `trust-posture.md` — a `self-referential-codify.md` allowlist file — into a self-referential edit. Same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity, `git.md` § CI-check/merge, and `issue-triage-routing.md` took.
- **Receipt requirement:** SessionStart soft-gate `[ack: hook-event-selection]` IFF `posture.json::pending_verification` includes the `hook-event-selection` rule_id.
- **Detection mechanism:** TWO tiers, and the split is load-bearing. **Structural (live, blocking):** `.claude/bin/validate-emit.mjs::checkHookEventDeclaration` (check id `hook-event-declaration`), which enumerates FROM THE REGISTRATIONS, NOT from a disk walk, and reads each hook's WHOLE FILE, NOT a header slice. Both were the other way in the first cut and both were changed under measurement, so the direction is stated precisely here rather than paraphrased. The loop runs over the `(event, matcher)` sets that `enumerateRegistrations(settings)` resolves to a canonical top-level `.claude/hooks/<name>.{js,mjs,cjs}` path; disk is consulted only to READ a registered hook's body, plus one trailing informational pass emitting a non-blocking `SKIP` for each top-level `.claude/hooks/*.js` carrying NO registration (`settings-hook-registration` owns that verdict). Enumerating from disk was fail-OPEN: a registration the walk missed produced NO ROW AT ALL — not PASS, not SKIP, not FAIL — and the walk demonstrably missed, because its filter took only `.js` while `canonicalHookRel` accepts `js|mjs|cjs`, and `isFile()` drops a symlinked hook. Slicing a header was fail-open the same way: a 4 kB cut swallowed a real `@hook-event: SessionStart (verification)` declaration at byte ~4500 — a hook that genuinely opted in, carrying the exact defect this rule blocks, waved through by the clause meant to spare hooks that never opted in. Whole-file scanning trades that silent swallow for a LOUD failure mode: an `@hook-event:` token quoted in a string or in example prose joins the declared set and FAILs MUST-4 set equality if it corresponds to no registration — visible, and one edit from resolution. Marker parsing itself is the exported pure `parseHookEventMarkers` (text in, plain data out, so the fixtures exercise every predicate with no repo on disk); the cross-check against `settings.json` runs through the SHARED `reconcile-settings-hooks.mjs` recognizers — it imports `enumerateRegistrations` + `normalizeMatcher` (the former applies `canonicalHookRel` transitively, so a non-canonical masquerading command is NOT read as a registration here either) rather than standing up a second recognizer, per `security.md` § Enforcement-Surface Parity, and that lazy seam discriminates on WHICH specifier is missing so a nested-dependency failure re-throws instead of degrading to SKIP. It FAILs on the four MUSTs — an unrecognized event or class token (positive allowlist per `cc-artifacts.md` Rule 10), an empty rationale, or a near-miss misspelling of the keyword (`@hook-events:`, `@hook_event:`) which is MALFORMED rather than silently dropped (MUST-1); a declared `(event, matcher)` set unequal to the registered set (MUST-4); a `verification` class token co-occurring with the `SessionStart` event (MUST-2); and MUST-3 on TWO arms — a `guard`/`verification` class on a tool-axis event with a `*` matcher OR with NO matcher at all (absent is the WIDEST matcher, not the narrowest, and was the cheaper bypass until the arm closed), and a `guard`/`verification` class declared at an event with no tool axis at all. A registered hook carrying NO marker is a NON-blocking advisory — a `SKIP` with a `WARN:`-prefixed detail, the established carrier in this validator for `hook-output-discipline.md` MUST-2 — but ONLY if it is named in the rule-land-time snapshot `.claude/hook-event-grandfather.json`. A hook registered AFTER this rule landed is not in that snapshot and FAILs on a missing marker, so the grandfather is bounded and the ratchet genuinely closes: new hooks cannot enter the exempt set, and the file is append-never (deleting a name once its hook declares is the intended direction). The loader fails CLOSED — a missing or malformed snapshot yields an empty set, so everything undeclared FAILs rather than everything passing. Audit fixtures at `.claude/audit-fixtures/validate-emit/run.mjs` (`fixture-hookEvent-*`, 26 cases, each with the mutation that reds it recorded in that directory's README) per `cc-artifacts.md` Rule 9, CI-wired through `.claude/test-harness/ci-audit-fixtures.json::runners["validate-emit"]`. **Semantic (Phase 1, manual, gate-review):** cc-architect at `/codify` (Step 6b) + reviewer at `/redteam` adjudicate whether a declared class is the CORRECT class for what the hook inspects. This half is NOT mechanized and NOT claimed as mechanized: the discrimination test reads a hook's semantics, and a lexical detector for it would be the exact over-claim this rule exists to block. Phase 2 is NOT deferred-pending-a-detector — no structural predicate for the semantic half is believed to exist.
- **Violation scope:** MUST-1 (undeclared or malformed marker) + MUST-2 (`verification` at `SessionStart`) + MUST-3 (`*` matcher on `guard`/`verification`) + MUST-4 (marker/`settings.json` disagreement) + both MUST NOT clauses. Every `violations.jsonl` row names the hook file, its registered `(event, matcher)`, and the declared class.
- **Origin:** See § Origin.

Origin: 2026-08-01 — co-owner-directed origination during the enforcement-registration wave, verbatim: _"you have a tendency to write hooks to trigger on sessionstart, which IS WRONG, it must be deliberated properly and fire in the right step (/redteam + /release or /deploy; and PostToolUse or Bash with the right scope)"_ and _"shouldn't you institutionalize it in /codify so that we don't even do that at the start? A lot of these errors over the past months would have functioned better as hooks."_ The institutionalization half landed at `commands/codify.md` Step 6b. Distinct from `hook-output-discipline.md` (what a hook emits once it fires) and from `reconcile-settings-hooks.mjs` (whether a registration resolves at all) — this rule owns whether the registered event can see the subject.

<!-- /slot:neutral-body -->
