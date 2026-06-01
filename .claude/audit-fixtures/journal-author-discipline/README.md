# journal-author-discipline audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One fixture
per author-backing predicate the F101-3 branch in
`.claude/hooks/journal-write-guard.js` (the `checkAuthorBacking` call from
`.claude/hooks/lib/provenance-author-backing.js`) relies on. Each fixture is a
self-contained PreToolUse stdin payload + an expected disposition (backing
status + severity verdict — the full validation-body prose is exercised by the
unit tests at `.claude/test-harness/tests/provenance-author-backing.test.mjs`
and the end-to-end WALK receipt in the F101-3 shard).

## Predicates covered

| Fixture                      | Predicate exercised                                                                  | Backing status | Disposition        |
| ---------------------------- | ------------------------------------------------------------------------------------ | -------------- | ------------------ |
| `01-backed-human/`           | author=human + ≥1 session HumanInput event in the live ledger                        | backed         | silent passthrough |
| `02-unbacked-human/`         | author=human + 0 session HumanInput events in the live ledger                        | unbacked       | halt-and-report    |
| `03-agent-na/`               | author=agent → never verified (no human-input claim); renders "n/a — agent-surfaced" | n/a-agent      | silent passthrough |
| `04-undetermined-no-ledger/` | author=co-authored + no per-session provenance ledger on disk                        | undetermined   | halt-and-report    |

## Why these and only these

`checkAuthorBacking` dispatches on exactly four statuses (its closed
predicate-space):

1. **agent branch** (`author=agent` → `n/a-agent`): no human-input claim is
   made, so nothing is verified — the ledger is not even read. Fixture 03 covers
   the cosmetic-label rule (MUST-2: renders "n/a — agent-surfaced", NEVER
   "BACKED by human input").
2. **ledger-resolved + count ≥ 1** (`backed`): a human|co-authored claim backed
   by a real session HumanInput event. Fixture 01.
3. **ledger-resolved + count == 0** (`unbacked`): a human|co-authored claim with
   no HumanInput event in this session. Fixture 02 — halt-and-report.
4. **ledger absent/unreadable/no session** (`undetermined`): the live ledger
   cannot answer the question. Fixture 04 — halt-and-report.

## Severity discipline (hook-output-discipline.md MUST-2)

The `unbacked` and `undetermined` dispositions are **`halt-and-report`, NEVER
`block`**. The F101-3 branch is REGISTRY-class — it reads a ledger file and
matches frontmatter, the same class as the slot-reservation lookup in the same
hook. An empty/absent ledger is AMBIGUOUS (degraded capture vs a genuine false
claim), so `block` would over-assert against a non-irrefutable signal. `block`
in this hook is reserved for `fs.existsSync` (the file-already-exists branch),
the only process-local structural primitive.

## Secrets fence (security.md "no secrets in logs")

The check counts events where `kind === "HumanInput"`. It MUST NOT read or emit
event PAYLOAD content (the ledger stores `prompt_sha256`, a commitment, never
verbatim prompt text). The fixtures carry NO secret material — the backing
status is derived from the event-kind count alone.
