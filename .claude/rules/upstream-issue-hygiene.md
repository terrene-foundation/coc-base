---
priority: 10
scope: path-scoped
paths:
  - "**/.github/**"
  - "**/CONTRIBUTING.md"
  - "**/SECURITY.md"
  - "**/.session-notes"
  - "**/journal/**"
  - "**/workspaces/**"
---

# Upstream Issue Hygiene

When a downstream session — a Python / Ruby / Rust binding consumer working with `kailash` / `kailash_*` packages — discovers a defect or feature gap in the underlying SDK, the natural action is to file an issue against the SDK repo. That action MUST be human-gated, and the issue body MUST contain ONLY information from the SDK's public-API surface — never the consumer project's name, internal paths, workspace identifiers, finding tags, or session context.

The defect goes upstream. The story of HOW you found it stays at home.

## Scope

ALL sessions running in a USE-template-derived consumer repo. Applies to ANY `gh issue create`, `gh pr create`, `gh issue edit`, or equivalent issue-filing command targeting an SDK repository (`kailash-py`, `kailash-rs`, `kailash-prism`, or any sibling distributed via PyPI / crates.io / gems).

## MUST Rules

### 1. Human Gate Before Filing

The agent MUST NOT execute `gh issue create`, `gh pr create` referencing an upstream SDK issue, or any equivalent issue-filing command against an SDK repo without explicit user approval IN THE SAME SESSION. Drafting the body is permitted; submission is not.

```bash
# DO — draft, present, wait for approval, then submit
draft="$(cat <<'EOF'
... # see Rule 3 for the required shape
EOF
)"
echo "Proposed issue body:"; echo "$draft"
echo "Approve filing against terrene-foundation/kailash-py? (y/N)"
read -r approval
[ "$approval" = "y" ] && gh issue create --repo terrene-foundation/kailash-py --title "..." --body "$draft"

# DO NOT — auto-submit because the rule said "file an issue"
gh issue create --repo terrene-foundation/kailash-py --title "feat: ..." --body "$draft"
# (no human gate; submitted before the user could redact downstream context)
```

**BLOCKED rationalizations:**

- "The cross-SDK parity rule said to file the issue"
- "The user already approved cross-SDK filing as a class"
- "Filing is a tool call, not a destructive action"
- "We can edit the body after if there's a problem"
- "The body is generic, no privacy concern"
- "Approval-per-issue is bureaucracy when the pattern is the same"

**Why:** Issues filed against public SDK repos are world-readable forever. Auto-filing without a per-issue gate ships downstream-context leaks (project names, internal file paths, workspace IDs) to a surface the user cannot scrub after the fact. The human gate is the only mechanism that catches a draft body's leakage BEFORE it becomes part of the public record. "We can edit later" is wrong: GitHub preserves issue body history; redaction is partial.

### 2. Downstream Context Redaction

The issue body MUST NOT contain any of:

- The downstream project's name (e.g., consumer app names, customer / engagement names)
- Internal file paths outside the SDK's import surface (e.g. `src/<consumer-app>/...`, `app/...`, `bindings/<consumer>/...`)
- Workspace identifiers (`workspaces/<name>/...`, `.session-notes`, `.proposals/...`, journal paths)
- Finding tags (e.g., `F-G1-HIGH`, `S-H3`, `BP-049`, internal redteam round IDs)
- Session timestamps tied to consumer work (e.g. `<date> <consumer-app> session`, `S07-reviewer-...`)
- "Origin: <consumer-app>" footers, "<consumer-app> workaround" sections, "Discovered during <consumer-name> red team" lines
- References to private SDK repos when filing on the public SDK repo

````markdown
# DO — body is scoped to the SDK API surface, no consumer context

## Summary

`DataFlow.execute_raw(sql, params)` raises `invalid byte sequence for encoding "UTF8"`
on a NEXT query after a NULL bind on a TEXT-typed column. The bytes do not appear
in any caller-side parameter; corruption originates at the FFI boundary.

## Reproduction

```python
import kailash
df = kailash.DataFlow("postgresql://...")
df.execute_raw("INSERT INTO t (col) VALUES ($1)", [None])
df.execute_raw("INSERT INTO t (col) VALUES ($1)", ["ascii-only"])  # raises UTF-8 error
```
````

# DO NOT — body carries consumer-project name + internal paths + finding IDs

## Summary

[same technical content]

## Origin

F-G1-HIGH S-H3 finding (<consumer-app> repo, 2026-04-27): non-atomic store_tokens in
live_oauth.py:192-237 and pseudo-atomic in oauth.py:470-536.

## Workspace

workspaces/<consumer-app>/journal/0020-DISCOVERY-dataflow-execute-raw-utf8-corruption.md

````

**BLOCKED rationalizations:**

- "Maintainers need the discovery context to triage"
- "The workspace path is internal to me, no leak"
- "The downstream name is just a tag, anyone could guess it"
- "Closed issues aren't really public"
- "The Origin footer is provenance, not context"
- "I'll keep the workspace path because it links back to the journal"
- "The finding tag is the most concise way to communicate severity"

**Why:** A public SDK issue is indexed by GitHub, search engines, code-search tools, and every downstream consumer's `gh issue list`. Every leaked downstream identifier becomes a permanent breadcrumb to a consumer project, its file structure, and its development methodology. Maintainers DO NOT need provenance to triage — they need a minimal repro and acceptance criteria (Rule 3). Provenance belongs in the consumer's local journal, not the upstream issue.

### 3. Minimal Repro Shape

The issue body MUST consist of ONLY:

1. **Affected SDK API surface** — one import path (e.g., `kailash.DataFlow.execute_raw`, `kailash_kaizen.LlmClient.embed`). No consumer wrappers, no consumer-side facade names.
2. **Minimal repro** — Python / Rust / Ruby code using ONLY `kailash` / `kailash_*` imports and `pytest` / `cargo test` / `rspec` standard scaffolding. No consumer modules, no consumer config files, no fixtures with consumer-derived names.
3. **Expected vs actual** — what the SDK contract promises (cite spec § or docstring) vs what the SDK delivers.
4. **Severity** — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` based on SDK-API-surface impact, NOT consumer-business impact.
5. **Acceptance criteria** — bulleted, testable, scoped to the SDK API. Format: `[ ] <observable behavior on the SDK surface>`.

Nothing else. No "## Workaround", no "## Workspace", no "## <consumer-app> wired around it like this", no "## Cross-references" pointing to consumer journals, no "## Cross-SDK alignment" sections.

```markdown
# DO — five required sections, nothing else

## Affected API
`kailash.DataFlow.execute_raw(sql: str, params: list)`

## Minimal repro
```python
import kailash
df = kailash.DataFlow("postgresql://localhost/test")
df.execute_raw("CREATE TABLE t (col TEXT)")
df.execute_raw("INSERT INTO t VALUES ($1)", [None])
df.execute_raw("INSERT INTO t VALUES ($1)", ["ascii-only"])
# Raises: psycopg.errors.CharacterNotInRepertoire: invalid byte sequence
````

## Expected vs actual

Expected: ASCII-only string parameter binds correctly.
Actual: UTF-8 decoding error on a parameter that contains zero non-ASCII bytes.

## Severity

HIGH — corrupts data path; non-deterministic; reproduces in CI.

## Acceptance criteria

- [ ] `execute_raw(sql, [None])` followed by `execute_raw(sql, [ascii_str])` succeeds.
- [ ] Tier 2 regression test added at `tests/integration/dataflow/test_execute_raw_null_bind.py`.

# DO NOT — the historical kitchen-sink shape

## Summary

[5 paragraphs of context including consumer name]

## Workspace

workspaces/<consumer-app>/journal/...

## Workaround

The consumer worked around it by ... [3 paragraphs of consumer-internal architecture]

## Cross-SDK alignment

This is the Python equivalent of <sibling-SDK>#NNN ...

## References

- <consumer-app> shard: S36d
- Tier 2 test suite: tests/integration/test*websocket*\*.py [in the consumer repo]

```

**BLOCKED rationalizations:**

- "The 'Workaround' section helps users hitting the same bug"
- "Cross-SDK alignment links speed up triage"
- "The consumer's Tier 2 tests are the verification — they must be referenced"
- "Five sections is too rigid for a complex issue"
- "The minimal repro doesn't show the production stack trace"

**Why:** Every section beyond the five required is a leakage surface. Workarounds belong in the consumer's local docs (the consumer is the one who wrote them, the only one who can keep them current). Cross-SDK alignment is a maintainer concern that the maintainer files separately on the sibling repo with their own scoped repro. Production stack traces beyond the minimal repro often contain consumer-side function names; the minimal repro is the structural defense.

## MUST NOT

- File any upstream SDK issue, PR, or PR-comment containing a downstream project name, internal path, workspace ID, or finding tag

**Why:** Once on the public record, redaction is partial; GitHub preserves edit history and the original body is recoverable.

- Treat "the user said yes once" as standing approval for future filings

**Why:** Standing approval erodes the per-issue gate that catches body-level leakage; each issue's body is unique and demands its own review.

- Auto-cross-file: filing on one SDK repo then auto-filing the sibling on a paired SDK repo without a separate human gate

**Why:** Auto-cross-filing replicates whatever leakage the first body contained, doubling the surface area; cross-SDK parity is a maintainer concern, not a consumer one.

Origin: A 2026-04-29 public SDK issue body leaked `F-G1-HIGH S-H3 finding (<consumer-app> repo, 2026-04-27): non-atomic store_tokens in live_oauth.py:192-237 and pseudo-atomic in oauth.py:470-536` into a public SDK issue. Sibling leaks confirmed across ~13 issues spanning two public SDK repos (consumer-app workspace paths, finding tags, "<consumer-app> workaround" sections, references to private SDK repos). Drafted as the structural defense after the leakage audit (loom 2026-04-30).
```
