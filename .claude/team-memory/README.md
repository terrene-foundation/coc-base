# .claude/team-memory/

Shared, signed, append-only memory facts that survive across operators in a
multi-operator COC repo. The split-rule layout — one file per fact — is the
structural defense against the failure mode where two operators
simultaneously promote conflicting "team conventions" into a single
team-memory.md and one silently overwrites the other.

F14 M7 Shard E (workspaces/multi-operator-coc 02-plans/01-architecture.md §7.3).

## Scope

`.claude/team-memory/` holds facts the team has agreed to remember together:
shared conventions, decisions, terminology bindings, environmental settings,
sibling-repo paths. It is the team-facing counterpart to per-operator
`~/.claude/.../MEMORY.md` (which is operator-specific, never shared).

This is NOT a replacement for:

- `specs/` — domain truth (what the system does today). Specs are
  human-authored, reviewed at /redteam, govern code at /implement.
- `.claude/rules/` — agent behavior governance. Rules emit to every
  session's baseline / path-scoped context.
- `journal/` — workspace-scoped event log (DECISION / DISCOVERY / DEFER).

Team-memory is the "what facts about us, the team, do we share" surface.
A team-memory fact MUST be:

1. Useful to ≥2 operators (not personal-preference).
2. Stable (not session-scoped or workspace-scoped — those belong in
   `.session-notes` and `journal/` respectively).
3. Non-secret (no tokens, passwords, internal API URLs — those belong in
   `.env`, never in a shared, signed, version-controlled file).

## Layout

```
.claude/team-memory/
  README.md                          ← this file (governance, layout, examples)
  <topic-slug>.md                    ← one fact per file (split rule)
  ...
```

Each `<topic-slug>.md` is:

- A markdown file with a frontmatter block recording the **signed
  attribution** (who promoted, when, the proposal SHA that justifies it).
- A short body (≤ 80 lines) explaining the fact in human language.
- An `Origin:` footer per `rules/rule-authoring.md` Rule 6 — points at the
  journal entry / proposal / `learning-codified.json` action that landed
  the fact.

## Promotion (read: how facts get here)

1. An operator's session captures the fact in `.session-notes` or a
   journal entry (per existing /journal / /wrapup discipline).
2. `/codify` proposes the fact for promotion: writes the candidate file
   under `.claude/.proposals/latest.yaml` AND drafts the
   `.claude/team-memory/<slug>.md` body. The proposal is reviewed at Gate-1
   per `rules/artifact-flow.md`.
3. On Gate-1 approval + /codify lease acquired, the
   `<slug>.md` is added under `.claude/team-memory/` and the proposal
   entry references the file by path.
4. M6's `coc-append.js` (the signed-attribution + body-anchor library
   landing concurrently in the parallel M6 shard) records the
   attribution-signing receipt — the team-memory file's frontmatter
   carries the operator's `verified_id` + `person_id` + signature over
   the file body.
5. `integrity-guard.js` (on main from B3) validates the structural shape
   on every read: frontmatter present, signed-attribution fields well-
   formed, body anchor matches recorded hash. Files violating the shape
   fail closed (the file is treated as absent until repaired).

## Editing / amending

Team-memory files are append-only at the FACT level — once a `<slug>.md`
lands, its body is not edited in place. To amend a fact:

1. Write a new fact file with a corrected `<slug>.md` (e.g. `<slug>-v2.md`).
2. Mark the prior file as superseded in its frontmatter
   (`superseded_by: <slug-v2>.md`, signed under the same /codify lease
   that lands the new file).
3. The superseded file remains in the directory as the historical record;
   readers consult the latest non-superseded file in the chain.

This is identical in shape to the
`rules/artifact-flow.md` § "Append, Never Overwrite Unprocessed
Proposals" discipline — both surfaces serve the same audit-trail need.

## Coexistence with /onboard

`/onboard` (the M7 deterministic read-path command) surfaces these files
to a new operator joining the team — they're the team's shared "things
you should know before editing" surface. The README files at this layer
and at the per-operator `.claude/operator-id` layer are read together to
produce the onboarding output.

## What does NOT live here

- Per-operator preferences → operator's own `~/.claude` settings or memory.
- Workspace-specific decisions → `workspaces/<name>/journal/` (the
  workspace journal is where workspace-local decisions live).
- Secrets / credentials / API keys → `.env` (and `.env` is gitignored).
- SDK / framework documentation → `docs/`, `skills/`.
- Cross-repo paths → `bin/lib/loom-links.mjs` (per `rules/cross-repo.md`).

## Origin

2026-05-22 — F14 M7 Shard E (knowledge convergence). Workspace plan
`workspaces/multi-operator-coc/02-plans/01-architecture.md` §7.3.
Architecture decision: split rule (one file per fact) over single
`team-memory.md`, because under N operators the single-file shape
re-creates the concurrent-edit class the /codify lease just solved.
