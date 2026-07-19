# adjacency-domain audit fixtures

Per `cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4. One
fixture per scope-restriction predicate the loom #757 domain-keyed SAME
predicate `adjacency.js::_matchDistillationDomain` relies on. Each fixture
is a self-contained `input.json` (a `sameReason(candidatePath, activeClaims,
opts)` invocation) + an `expected.json` (the structured `{matched, predicate}`
disposition, asserted by value — a STRUCTURAL probe per
`probe-driven-verification.md` Rule 3, not a regex over prose).

The predicate is claim-time only and DUMB-equality only: it fires SAME iff
the claim carries a non-empty opaque `domain` handle AND
`opts.candidateDomain` equals it. The caller normalizes the domain token at
classify-time (`rules/agent-reasoning.md`: dumb lib, LLM reasons).

## Predicates / scope-restrictions covered

| Fixture                              | Scope-restriction exercised                                                                                       | Expected disposition                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `01-same-domain-different-slug/`     | Same `domain` handle, DIFFERENT workspace slugs (all path predicates null) → the domain predicate is the ONLY SAME signal | `matched:true, predicate:distillation-domain` |
| `02-different-domain-not-same/`      | Claim `domain` set but `opts.candidateDomain` differs → dumb equality fails, no path overlap                     | `matched:false`                          |
| `03-absent-domain-inert/`            | Claim has NO `domain`; `opts.candidateDomain` set. Predicate MUST NOT fire off `candidateDomain` alone; path predicates unaffected | `matched:false`                          |
| `04-additive-path-claim-still-fires/`| Purely-additive property: an existing PATH claim (no `domain`) still fires its path predicate unchanged           | `matched:true, predicate:exact`          |

## Why these and only these

The predicate's scope-restrictions are:

1. **Non-empty `claim.domain` guard** — an absent / empty `domain` is inert.
   Fixture 03 pins this: a domainless claim does NOT match even when
   `opts.candidateDomain` is populated (the predicate keys on the CLAIM's
   domain, never on `candidateDomain` alone).
2. **Dumb strict equality** (`opts.candidateDomain === claim.domain`) — no
   parsing, no normalization, no path arithmetic. Fixture 01 (equal → SAME)
   and fixture 02 (unequal → not SAME) cover both sides.
3. **Path-blind additivity** — the predicate reads ONLY `domain` /
   `candidateDomain`, never the candidate path, so it neither masks nor is
   masked by the path predicates (a)–(e). Fixture 01 proves it fires on a
   different-slug pair the path predicates miss; fixture 04 proves an
   ordinary path claim still fires its own predicate (`exact`) with the
   domain predicate inert.

Predicate source: `.claude/hooks/lib/adjacency.js::_matchDistillationDomain`
(SAME predicate (domain)). Live behavioral coverage:
`.claude/test-harness/tests/adjacency-domain-predicate.test.mjs`, which
drives these fixtures via a real subprocess `require()` of the on-disk lib.
