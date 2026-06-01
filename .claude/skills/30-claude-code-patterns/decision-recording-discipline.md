# Decision-Recording Discipline — Author-Backing Verifiability

Procedural depth for the `journal-author-discipline.md` MUST clauses. The load-bearing tripwires live in `.claude/rules/journal-author-discipline.md`; this sub-file carries the author decision-tree annotated with the verifiability layer, the ledger signature per label, the `_ledgerPath` + `kind:"HumanInput"` count semantics, the secrets fence, the halt-and-report remediation runbook, the "n/a — agent-surfaced" cosmetic rule, and a worked DO/DO-NOT pair.

## Why this lives in a skill (not the rule)

The MUST clauses are load-bearing baseline-class content. The decision-tree, the count semantics, the secrets fence, and the remediation runbook are reference material the agent needs available WHEN it is about to write a journal entry — not on every session start. Per `cc-artifacts.md` MUST NOT "No knowledge dumps … Extract reference to skills" + the `worktree-orchestration.md` / `closure-parity-specialist-discipline.md` precedent (rule body holds the tripwire; depth goes here).

## The author decision-tree, annotated with the verifiability layer

`rules/journal.md` defines the author classification:

- **`human`** — the user stated the conclusion before the AI.
- **`agent`** — the AI surfaced it unprompted.
- **`co-authored`** — the decision evolved through exchange (the default when uncertain).

F101-3 adds the verifiability layer on top. Each label maps to an expected ledger signature:

| `author:`     | Claim about origination   | Expected live-ledger signature             | `checkAuthorBacking` status (count semantics) |
| ------------- | ------------------------- | ------------------------------------------ | --------------------------------------------- |
| `human`       | user stated it first      | ≥1 `kind:"HumanInput"` event this session  | `backed` (count ≥ 1) / `unbacked` (count = 0) |
| `co-authored` | evolved through exchange  | ≥1 `kind:"HumanInput"` event this session  | `backed` (count ≥ 1) / `unbacked` (count = 0) |
| `agent`       | AI surfaced it unprompted | (not checked — no human claim is made)     | `n/a-agent`                                   |
| any non-agent | (treated as human-class)  | ≥1 `kind:"HumanInput"` event this session  | `backed` / `unbacked`                         |
| (any author)  | —                         | ledger absent / unreadable / no session id | `undetermined`                                |

The verifiability layer does NOT change the author taxonomy — it adds an evidence check. `human`/`co-authored` are human-class claims that the ledger can confirm or contest; `agent` makes no human claim, so there is nothing to verify.

## `_ledgerPath` + `kind:"HumanInput"` count semantics

The ledger is resolved via `.claude/hooks/lib/provenance-ledger.js::_ledgerPath(repoDir, session)` — the SAME helper the F101-2 capture path uses. It returns:

```
.claude/learning/provenance/<sanitized-session>-<sha8>.jsonl
```

(the session id is sanitized to a safe filename token AND suffixed with an 8-char sha256 of the RAW id, so the mapping is injective). `checkAuthorBacking` MUST reuse `_ledgerPath` — never re-derive the path.

The count is mechanical: read the ledger best-effort, split on newlines, `JSON.parse` each non-empty line, and count events where `event.kind === "HumanInput"`. The closed event taxonomy is `provenance-event.js::EVENT_KINDS` = `["HumanInput", "Action", "Decision", "Delegation"]`; only `HumanInput` is counted. A single corrupt line is skipped (not fatal) — the chain-corruption path is handled separately by `provenance-ledger.js::_deriveChainHead`.

## Secrets fence (security.md "no secrets in logs")

The provenance ledger stores `prompt_sha256` — a commitment — NEVER verbatim prompt content. The author-backing check MUST read ONLY the `kind` discriminator of each event. It MUST NOT read, parse, or emit any event PAYLOAD content (which carries `prompt_sha256`, `command_sha256`, `file_path`, etc.). A count of `HumanInput` events is not a disclosure; reading the payload to "see what the human said" would be. The fence is structural: the checker's return shape exposes `{status, humanInputCount, ledgerPath, label}` — no payload field can leak through it.

## The "n/a — agent-surfaced" cosmetic rule

An `author: agent` entry renders the cosmetic label **`n/a — agent-surfaced`** — NEVER `BACKED by human input`. The agent branch short-circuits BEFORE any ledger read: an agent-surfaced entry makes no human-input claim, so there is nothing to verify and asserting human backing would be a category error. This is MUST-2 of the rule; the label is enforced in `backingLabel("n/a-agent")`.

## Halt-and-report remediation runbook

When the F101-3 branch in `journal-write-guard.js` emits `halt-and-report`, the disposition depends on the status:

- **`unbacked`** (human|co-authored claim, 0 HumanInput events this session):
  1. If no human input actually shaped the entry → set `author: agent` (renders `n/a — agent-surfaced`); the entry is honest and the write proceeds.
  2. If a human DID drive the decision but the session captured zero HumanInput events → surface WHY (the F101-2 capture hooks may have been degraded; the UserPromptSubmit capture may have failed). Reconcile the author classification with the user before retrying.
- **`undetermined`** (no live ledger on disk):
  1. The per-session ledger is genuinely absent (capture degraded or never ran). Confirm the author classification with the user.
  2. If the entry is agent-surfaced, set `author: agent` and proceed.
  3. Do NOT silently proceed with the human|co-authored claim — `undetermined` is "we cannot verify", which MUST halt, never auto-pass (MUST-3).

The disposition is NEVER to edit the ledger to manufacture backing (the ledger is a per-session append stream csq drains + signs; a hand-edit is unsigned and drops on csq's fold).

## Worked DO / DO-NOT pair

```text
# DO — agent surfaced the discovery; honest author:agent renders n/a
$ /journal --new   # entry frontmatter: author: agent
journal-write-guard: status n/a-agent → passthrough.
Backing label: "n/a — agent-surfaced".  (No ledger read; no human claim made.)

# DO — human drove the decision; session ledger carries HumanInput; backed
$ /journal --new   # entry frontmatter: author: human
journal-write-guard: checkAuthorBacking → status backed (humanInputCount ≥ 1) → passthrough.
Backing label: "BACKED by human input".

# DO NOT — claim author:human with no human turn captured this session
$ /journal --new   # entry frontmatter: author: human, session ledger has 0 HumanInput
journal-write-guard: status unbacked → halt-and-report.
"author:human is UNBACKED — 0 HumanInput events this session. Set author:agent,
 or surface why the session captured zero HumanInput events."
# The fix is NOT to edit the ledger; it is to correct the author claim OR
# reconcile the capture gap with the user.
```

## Cross-references

- `.claude/rules/journal-author-discipline.md` — the load-bearing MUST clauses (this depth-file's rule).
- `.claude/rules/journal.md` — the author decision-tree this layer annotates.
- `.claude/hooks/lib/provenance-author-backing.js::checkAuthorBacking` — the implementation.
- `.claude/hooks/lib/provenance-ledger.js::_ledgerPath` — the canonical ledger-path resolver.
- `.claude/hooks/lib/provenance-event.js::EVENT_KINDS` — the closed event taxonomy (`HumanInput` is the counted kind).
- `rules/verify-resource-existence.md` MUST-2 — the live-evidence-not-hearsay principle this layer instantiates for journal authorship.
- `rules/hook-output-discipline.md` MUST-2 — why the branch is `halt-and-report`, never `block`.
