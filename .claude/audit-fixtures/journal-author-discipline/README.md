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

## Why every payload here carries a CONTRACT-CONFORMANT frontmatter block

Each `input.json` above carries the full canonical frontmatter block
(`rules/journal.md` § Naming & Format: `type`, `date`, `author`, `project`,
`topic`, `phase`, `verified_id`, `person_id`, `display_id`, `tags`) and carries
**no** `session_id:` key. Neither is decoration, and neither may be trimmed back
to "just enough to carry `author:`".

`journal-write-guard.js` runs a SECOND, independent obligation over the same
bytes — `lib/journal-frontmatter-shape.js`, rule_id `journal/frontmatter-shape`,
severity `advisory`. The earlier payloads here predate it and violated it: six
required keys absent and `session_id:` RETIRED. That made every row a COMPOUND
assertion about BOTH layers instead of the author-backing layer each one names —
visibly so on `01` and `03`, whose declared `stderr_tag: (none)` became
`[ADVISORY]`, and invisibly on `02` and `04`, where the advisory rode along
inside a `[HALT-AND-REPORT]` emit that nothing here asserts the contents of.

The corpus is bipolar on ONE axis: the author claim and the ledger state. Had
only the two passthrough fixtures been made conformant, the passthrough and
halting poles would differ on author/ledger **and** on shape, which is the same
compound-assertion defect displaced from inside a case to across the corpus. So
all four carry the conformant block and the poles differ on the author axis
alone.

The guard reads only `author:` out of this block (`parseFrontmatterAuthor`);
`verified_id` / `person_id` / `display_id` are self-evidently fixture values and
no verdict turns on their content. End-to-end assertion that the shape layer
FIRES is not duplicated here — it lives in `../journal-write-guard/run.mjs` C13,
which is the suite that owns end-to-end behaviour for this hook.

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
