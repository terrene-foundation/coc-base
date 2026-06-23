---
coc.version: 1.0.0
---

# COC — Unified Cognitive-Orchestration Artifact Set

This `.coc/` directory is the **unified, CLI-neutral** artifact set for this
repository, emitted by loom alongside the per-CLI variants (`.codex/`,
`.gemini/`, `AGENTS.md`, `GEMINI.md`). It is a composed-files overlay — plain
files in your repo, the same trust model as the per-CLI artifacts. There is no
signing and no trust prompt; you control what lands here through the same review
channel you use for any other repository content.

## Layout

| Path           | Contents                                                        |
| -------------- | --------------------------------------------------------------- |
| `COC.md`       | This primer; declares the `coc.version` envelope.               |
| `COC.lock`     | Canonical JSON manifest: SHA-256 of every other file under `.coc/`. |
| `rules/`       | One Markdown file per rule (`<ID>.md`).                          |
| `agents/`      | One Markdown file per agent.                                     |
| `skills/`      | One Markdown file per skill (the SKILL.md entry point).          |
| `commands/`    | One Markdown file per command.                                   |

## Frontmatter

Each artifact carries strict YAML 1.2 frontmatter with a grammar-conforming
`id` (`^[A-Z][A-Z0-9-]{1,32}$`, file basename equals `id`). Rules may carry a
`paths` path-scope filter. An `applies_to` surface allowlist is present only
when the artifact is surface-specific; a universal artifact omits it. The
`coc.version` envelope is declared here once and omitted per-artifact.

Agents, commands, and skills additionally carry a **typed superset** beyond
`id`, copied verbatim from each artifact's source frontmatter — so a field is
present only when the source declares it: agents carry `name`/`description`
(+ optional `tools`/`model`/`hooks`); commands carry an optional `name` handle
(+ optional `description`/`argument-hint`/`model`; absent → the handle derives
from the artifact filename, as in the native surface); skills carry `name`
and/or `description`. These fields let a conforming runtime reconstruct the
native surface (subagent registry, `/command`, eager-loaded skill description)
— Level-2 fidelity. They are additive and omittable: a consumer that does not
parse them reads them as unknowns and delivers the Level-1 injection floor (a
clean degrade, never a parse failure).

## Contents

- rules: 39
- agents: 6
- skills: 16
- commands: 19

## Authorship

Loom owns `.coc/` emission; downstream consumers read it (read-only). The
format conforms to the published consumer contract
`governance.csq:specs/09-unified-coc-artifact-standard.md`.
