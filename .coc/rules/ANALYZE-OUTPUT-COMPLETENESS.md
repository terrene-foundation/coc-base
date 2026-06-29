---
id: "ANALYZE-OUTPUT-COMPLETENESS"
paths: ["**/.claude/commands/analyze.md", "**/.claude/commands/todos.md", "**/.claude/commands/implement.md", "**/.claude/hooks/analyze-completeness-guard.js", "**/workspaces/**"]
---

# Analyze Output-Completeness — Every Compulsory Output Before Advancing

`/analyze` declares four compulsory output trees — `01-analysis/`, `02-plans/`, `03-user-flows/`, and `specs/` — but naming them in the command prose is not enforcement. A session can declare `/analyze` complete with `03-user-flows/` empty and `/todos` proceeds on unvalidated user journeys: feature planning sent into a wild-goose chase around features whose flows were never validated. Prose self-policing IS the failure class — the command named the outputs twice and they were still skipped. The fix is a structural phase-boundary gate.

## MUST Rules

### 1. `/analyze` Is Not Complete, And `/todos`/`/implement` MUST NOT Advance, While A Compulsory Output Tree Is Empty

Before `/analyze` is declared complete, AND before any `/todos` or `/implement` invocation advances, EACH compulsory output tree in the active workspace MUST contain ≥1 non-`.gitkeep` `.md` file:

- `workspaces/<project>/01-analysis/`
- `workspaces/<project>/02-plans/`
- `workspaces/<project>/03-user-flows/`
- `specs/` — satisfied by EITHER `workspaces/<project>/specs/` OR repo-root `specs/` (the corpus is ambiguous: `specs-authority.md` Rule 1 says project root, Rule 9 says `workspaces/<project>/specs/`; either populated location satisfies the gate).

The gate fires ONLY when analysis has STARTED (≥1 workspace-local tree non-empty) — a fresh workspace with every tree empty is a legitimate not-yet-started state and MUST NOT block. A change with genuinely no user-facing surface (a pure back-end refactor) does NOT skip `03-user-flows/` silently: write `03-user-flows/00-no-user-flows.md` stating WHY. That documented-rationale file is a real `.md` and satisfies the gate.

```bash
# DO — run the find battery; ANY INCOMPLETE line blocks completion + advance
W="workspaces/<project>"
for tree in 01-analysis 02-plans 03-user-flows; do
  find "$W/$tree" -type f -name '*.md' ! -name '.gitkeep' 2>/dev/null | grep -q . \
    || echo "INCOMPLETE: $W/$tree empty"
done

# DO NOT — declare /analyze complete with 03-user-flows/ empty because the
# command prose "names" it; advance to /todos on unvalidated journeys
echo "/analyze complete"   # 03-user-flows/ never populated; /todos proceeds blind
```

**BLOCKED rationalizations:**

- "The command already names the outputs; the author will populate them"
- "User flows are implied by the plans; a separate tree is ceremony"
- "This is a back-end change, user flows don't apply" (write the documented `00-no-user-flows.md` rationale — do not skip silently)
- "We'll backfill 03-user-flows after /todos"
- "The analysis is obviously complete; the gate is overhead"
- "specs/ lives at the repo root, the workspace tree doesn't need it"

**Why:** Feature planning built on incomplete analysis is the most expensive wrong turn an autonomous session can take — every downstream `/todos` and `/implement` cycle compounds the un-validated premise. The gate converts a prose MUST that was demonstrably skippable into a structural file-state check the agent cannot rationalize away: the directory either holds output or it does not. Origin: loom#675 — `/analyze` declared complete with `03-user-flows/` empty even though the command named the output twice.

## Trust Posture Wiring

- **Severity:** `block` at the hook layer — `.claude/hooks/analyze-completeness-guard.js` DENIES the advancing Skill on the IRREFUTABLE empty-directory fact (a deterministic `fs.readdirSync` of the resolved tree — file-state, not lexical; no surface rewrite evades "this directory holds no non-`.gitkeep` `.md`"), which `hook-output-discipline.md` MUST-2 enumerates as block-grade (file existence). The block decision composes that structural fact with a workspace SELECTION heuristic (explicit arg, else newest-mtime, the SAME algorithm the advancing command uses); the two reads happen at different moments, so under concurrent sibling-mtime churn they MAY select different workspaces. `block` remains correct because the DOMINANT residual is a RARE, RECOVERABLE false-block (re-run with an explicit `/todos <project>` arg, which the hook honors, or populate the tree). The symmetric case — a concurrent session bumping an INCOMPLETE sibling's mtime between the hook's PreToolUse read (T1) and the command's read (T2) — CAN let the command advance on a sibling the hook did not gate: a BOUNDED escape (the intrinsic PreToolUse-eval-vs-tool-exec TOCTOU shared by `genesis-anchor-guard.js` / `validate-bash-command.js`), re-caught by the next phase-gate, with NO data loss / credential escape / privilege escalation (practically unreachable on single-operator loom). ANY ambiguity (unresolved workspace / error / timeout) fails OPEN per `cc-artifacts.md` Rule 7. This is the same bounded-false-block-justifies-teeth posture as `genesis-anchor-guard.js` / `validate-bash-command.js`; a future maintainer MUST NOT read "structural" here as license to extend `block` to a genuinely lexical or unbounded-heuristic sibling check. `halt-and-report` at gate-review (cc-architect / reviewer at `/codify` confirms `commands/analyze.md` carries the gate section AND the hook is registered).
- **Grace period:** 7 days from rule landing (2026-06-26 → 2026-07-03).
- **Cumulative posture impact:** same-class violations (advancing past `/analyze` with a compulsory tree empty) contribute to `trust-posture.md` MUST Rule 4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** any same-class violation within 7 days routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST Rule 4 (1× = drop 1 posture) — no dedicated trigger key, so no edit to the self-referential `trust-posture.md` is required.
- **Receipt requirement:** SessionStart MUST require `[ack: analyze-output-completeness]` in the agent's first response IFF `posture.json::pending_verification` includes this rule_id (set at land-time, cleared after grace). Soft-gate.
- **Detection mechanism:** structural — `.claude/hooks/analyze-completeness-guard.js::decideAnalyzeGate` fires at PreToolUse(Skill) on `/todos`/`/implement`, returning `block` when analysis has started but a compulsory tree is empty (fail-open on any error/timeout/unresolved-workspace; ≤5s budget per `cc-artifacts.md` Rule 7). The detector is a file-state check (NOT a lexical regex), so the `probe-driven-verification.md` MUST-4 lexical-hook-needs-a-probe pairing does not apply. Paired `/codify` mechanical sweep: cc-architect confirms `commands/analyze.md` carries the Output-Completeness Gate section AND `settings.json` registers the hook under a `Skill` matcher. Audit fixtures at `.claude/audit-fixtures/analyze-completeness-guard/` (one per scope-restriction predicate per `cc-artifacts.md` Rule 9): block / user-flows-missing / pass / dual-location-specs / fresh-workspace / non-advance-skill / documented-no-user-flows / explicit-arg-selection / newest-of-N-selection.
- **Violation scope:** MUST-1 (advance-while-incomplete) fires the Wiring.
- **Origin:** See § Origin.

## Origin

loom#675 (2026-06-26) — `/analyze` declared complete with `03-user-flows/` empty even though `commands/analyze.md` named the output twice and the red-team step stated "Analysis, user flows must flow into plans"; the command carried a phase-complete gate for JOURNAL entries (`commands/analyze.md` § Journal) but none for the output trees. Incorporated as a co-owner-directed origination (`artifact-flow.md` § Co-Owner-Directed Origination); receipt-first DECISION `journal/0341`. Self-referential codify (the `sync-manifest.yaml` tier edit is on the `self-referential-codify.md` allowlist) → multi-agent redteam-with-tests to convergence.
