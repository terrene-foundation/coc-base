---
priority: 10
scope: path-scoped
paths:
  - "**/STACK.md"
  - "**/.claude/agents/onboarding/**"
  - "**/.claude/commands/onboard-stack.md"
  - "**/.claude/skills/40-stack-onboarding/**"
---

# Stack Detection Discipline (base variant)

<!-- slot:neutral-body -->

The base variant adopts COC discipline in arbitrary stacks (Go, Java, TypeScript, Python-non-Kailash, Rust, Elixir, Swift, Kotlin, .NET, Ruby, PHP, polyglot mixes). Every COC phase command (`/analyze`, `/todos`, `/implement`, `/redteam`, `/codify`, `/release`) needs to know which stack it is operating in to invoke the right test runner, package manager, build tool, and lint pipeline. `STACK.md` is the institutional record of that answer.

This rule binds `STACK.md` schema, freshness, and detection-source provenance — same discipline the kailash variants get from `pyproject.toml` / `Cargo.toml` / `Gemfile` parsing, generalized to arbitrary stacks.

## MUST Rules

### 1. STACK.md MUST Exist Before /implement, /codify, /redteam

A base-variant project MUST have `STACK.md` at the repo root before invoking any phase command that exercises stack-coupled tooling (`/implement` runs tests; `/codify` invokes lint; `/redteam` runs the full audit). Phase commands without `STACK.md` MUST emit a halt-and-report directing the user to `/onboard-stack`.

```yaml
# DO — STACK.md at repo root before /implement
declared_stack: typescript
secondary_stacks: []
detected_at: 2026-05-06T16:30:00Z
confidence: HIGH
detector_version: 1.0.0
evidence:
  - package.json (typescript@5.4.2, vitest@1.5)
notes: |
  Vite + React frontend, vitest for Tier-1, Playwright for E2E.

# DO NOT — phase command runs without STACK.md
$ /implement   # → halt-and-report: "Run /onboard-stack first; STACK.md is missing"
```

**BLOCKED rationalizations:**

- "I know what stack this is, I don't need STACK.md"
- "I'll create STACK.md after running /implement"
- "STACK.md is for new users, not for me"
- "The phase command can detect the stack on the fly each time"
- "/onboard-stack is overhead for a project I just opened"

**Why:** Stack detection performed inline by every phase command produces inconsistent answers (different commands hit different manifest files, polyglot repos resolve differently). `STACK.md` is the single durable answer that every command grounds in. The kailash variants never face this because the SDK pins in `pyproject.toml` / `Cargo.toml` ARE the canonical answer; the base variant has no SDK pin → it has STACK.md instead.

### 2. STACK.md Schema (Required Fields)

`STACK.md` MUST be valid YAML (frontmatter or pure-YAML) with these fields:

| Field              | Type               | Description                                                                                                                          |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `declared_stack`   | string             | One of: `python`, `typescript`, `javascript`, `go`, `rust`, `ruby`, `java`, `kotlin`, `swift`, `elixir`, `csharp`, `php`, `polyglot` |
| `secondary_stacks` | list[string]       | Additional stacks tracked (e.g., `[python]` for a TS app with Python ETL)                                                            |
| `detected_at`      | ISO 8601 timestamp | When the detection was last run                                                                                                      |
| `confidence`       | enum               | `HIGH` / `MEDIUM` / `LOW` / `UNKNOWN`                                                                                                |
| `detector_version` | string             | `stack-detector` agent version that produced this record                                                                             |
| `evidence`         | list[string]       | Manifest files inspected + key versions found                                                                                        |
| `notes`            | string (optional)  | Free-form additional context                                                                                                         |

Phase commands MUST refuse to operate on a STACK.md missing any required field. Unknown additional fields are permitted (forward-compat).

### 3. Stack Claims MUST Come From A Verifying Command, Not Memory

Per `testing.md` MUST "Verified Numerical Claims In Session Notes" (generalized) and `verify-resource-existence.md` (existence check before action), `STACK.md` updates MUST be produced by re-running `stack-detector` against current manifest files. Hand-typing or copy-pasting a previous session's `STACK.md` content is BLOCKED.

```bash
# DO — re-detection produces fresh evidence
$ /onboard-stack          # invokes stack-detector
$ cat STACK.md            # verify YAML schema
$ git add STACK.md && git commit -m "chore: refresh STACK.md (vitest 1.5 → 1.6)"

# DO NOT — copy STACK.md from another project without re-detecting
$ cp ../sibling-project/STACK.md ./STACK.md
$ git commit -am "add STACK.md"   # blocked: detected_at, evidence are stale
```

**BLOCKED rationalizations:**

- "The other project has the same stack, copying is faster"
- "I know what's in package.json, I don't need to verify"
- "stack-detector is for first-time onboarding, not maintenance"
- "The schema validates; that's enough"

**Why:** Stale `detected_at` + `evidence` make session-notes claims about stack-coupled tooling unverifiable (per `zero-tolerance.md` Rule 1c — claims after a context boundary need provenance). Re-detection is O(seconds); the alternative is a cascade of phase commands acting on stale assumptions.

### 4. Polyglot STACK.md Declares Primary + Secondary

For a polyglot codebase (TypeScript frontend + Python ETL sidecar; Rust core + Go orchestrator; Java backend + Kotlin Android), `declared_stack` is the stack hosting the MAJORITY of code OR the user-designated primary. `secondary_stacks` lists the others. `confidence: MEDIUM` is the default for polyglot detection unless the user confirms a primary at HIGH.

```yaml
# DO — polyglot honestly declared
declared_stack: typescript
secondary_stacks: [python, rust]
confidence: MEDIUM
notes: |
  TS Vite frontend (primary), Python ETL sidecar, Rust wasm module
  for compute. Phase commands run vitest by default; pytest invoked
  for src/etl/, cargo test for src/wasm/.
```

**Why:** Phase commands consult `declared_stack` to choose tooling; without a clear primary they oscillate. The `secondary_stacks` list is the explicit handoff to per-language skills (`skills/40-stack-onboarding/<stack>/`).

## MUST NOT

- **Run /implement against a project without STACK.md.**

**Why:** /implement invokes test runners, formatters, build tools — all stack-coupled. Without STACK.md, the phase command guesses, and inconsistent guesses across phases produce silent state drift.

- **Edit `declared_stack` or `secondary_stacks` without re-running `stack-detector`.**

**Why:** Same provenance concern as Rule 3. The fields exist to record what was detected, not what the user wishes was detected.

- **Treat absence of STACK.md as license to detect inline per command.**

**Why:** Inline detection per command produces N answers across N phases. STACK.md is one answer for all of them.

## Trust Posture Wiring

- **Severity:** `halt-and-report` for missing-or-stale STACK.md (Rules 1, 3, 4); `advisory` for schema-warning cases (e.g., extra unknown fields).
- **Grace period:** 14 days from rule landing (longer than the 7-day default since base-variant adoption is greenfield — early users haven't formed habits yet).
- **Regression-within-grace:** any phase command invoked with missing STACK.md AFTER `/onboard-stack` was previously run in the same project triggers a cumulative violation; 3× same-project = emergency downgrade.
- **Detection mechanism:** phase commands MUST read STACK.md as their first step. `cc-architect` mechanical sweep at `/codify`: every phase command body greps for `STACK.md` and refuses without it.

Origin: 2026-05-06 — base variant Phase 1 codifies the structural defense against stack-detection drift at the rule layer. Kailash variants face the analogous problem at `pyproject.toml` / `Cargo.toml` parse-time; the base variant face it at `STACK.md` parse-time. Pairs with `commands/onboard-stack.md` (the discovery surface) and `agents/onboarding/stack-detector.md` (the detection mechanism).

<!-- /slot:neutral-body -->
