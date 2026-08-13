# Instrument Discipline — Depth (relocated)

**The depth for `.claude/rules/instrument-discipline.md` now lives at
`.claude/guides/rule-extracts/instrument-discipline.md`.** Read it there. This file is a
pointer, not a second copy — there is no content here to drift out of sync with the canonical
one (`command-skill-parity.md` MUST-1's no-duplicate-runbook shape, applied to a rule↔depth pair).

## Why it moved (R7 finding, 2026-07-31)

`rules/instrument-discipline.md` is a `priority: 0` `coc-core` baseline rule reaching py + rs +
base and every downstream consumer, on all three CLI lanes. This tree is **CLI-EXCLUDED for
codex AND gemini** (`sync-manifest.yaml::cli_emit_exclusions.codex` and `.gemini` both list
`skills/30-claude-code-patterns/**`). Hosting the rule's ONLY depth pointer here therefore
dangled on two of the three CLI lanes.

**CORRECTION #4 (R13-sec HIGH-1).** This paragraph previously ended: "`guides/rule-extracts/**`
is in NEITHER exclusion list, so it reaches all three." That is a NON-SEQUITUR and was formally
withdrawn in `sync-manifest.yaml` § `# CORRECTED 2026-07-31 (R10 HIGH-2)` (`:1289-1302` as a
paired hint only) in this same PR — the copy here was left standing.
Absence from an exclusion list is consistent with BOTH "included" and "never a candidate".
MEASURED: `emit-cli-artifacts.mjs` walks `.claude/{commands,agents,skills}` and has NO
`.claude/guides` walk (grep for `guides` over that file returns one line, a prose comment at
:834), so `guides/**` is never a candidate for CLI emission. **The relocation is a
corpus-consistency choice, not a reachability fix.**

**CORRECTION #5 (R14-sec MED-1) — #4 inverted its own error.** #4 went on to claim "the
codex/gemini depth gap is STILL OPEN". That reads an EMISSION-LANE fact as a FILESYSTEM fact,
which is #4's own mistake pointed the other way. MEASURED via `sync-tier-aware.mjs --dry-run
--json`, reading the per-file action rather than substring-matching the plan:

```
.claude/guides/rule-extracts/instrument-discipline.md   action:copy   reason:tier_match
```

`sync-tier-aware.mjs` does not consume `cli_emit_exclusions` at all (grep count 0; positive
control `emit-cli-artifacts.mjs` = 2), so on-disk delivery is NOT gated by it. The depth file
ships to every target's `.claude/` on BOTH the USE and BUILD lanes, and the rule's pointer line
survives the codex/gemini abridge (it opens "Instrument table…", matching neither the `^See `
nor `^Depth ` strip shapes). **So a codex/gemini consumer gets the MUST clauses AND a resolving
depth pointer. Nothing dangles.** What those lanes lack is the depth INLINE in context — it is
read on demand instead. That is by design, not an open gap.

Correction #5 withdrew #4's conclusion but left a later paragraph standing that still asserted
it — that a codex/gemini consumer gets "**neither** the inline BLOCKED corpus **nor** a
resolvable depth file", citing the very correction that withdrew it as its authority. R15
DELETED that paragraph rather than minting a sixth correction: it was a dependent of #4, so
removing it COMPLETES #5 instead of adding a new claim. Re-measured before deleting, reading
the per-file action rather than substring-matching the plan — `action:copy reason:tier_match`
on the USE lane (`--target rs`) AND the BUILD lane (`--build rs`). The falsifying result is
producible by that same instrument and was NOT observed: the sibling
`test-harness/probes/instrument-discipline.probes.jsonl` row in the same output reads
`action:skip reason:exclude`. (That path is the file as it stood AT THAT MEASUREMENT; the
suite has since graduated to `test-harness/probes/instrument-discipline.probes.json` and the
`.jsonl` is deleted. The historical reading above is left verbatim rather than restated over
the new path, because re-running the plan needs an operator `loom-links.local.json` this
graduation session did not have — so the new file's lane action is UNMEASURED here, not
assumed to match.)

**The defect is CLI-EXCLUSION, not tier.** Both the old and new homes are the SAME `cc` tier —
`skills/30-claude-code-patterns/**` and `guides/rule-extracts/**` are both inside the `cc:`
block. Nothing was ever hosted under a narrower tier. The manifest's `Do NOT host a coc-core
rule's depth under a NARROWER tier` invariant names `kailash` (a tier base genuinely does not
subscribe); it was never violated here and remains a live sibling hazard this move did not hit.

The rule corpus already used the guides tree correctly for `autonomous-execution.md` and
`repo-scope-discipline.md`; this rule did not follow it.

FIVE corrections to this file's own earlier versions, recorded rather than quietly replaced
(the first three are enumerated immediately below; #4 and #5 are the two blocks ABOVE, added
after this paragraph was written — the count read "Three" until R14-corr LOW-3 caught it
undercounting its own list, which is the same count-contradicts-its-list class recorded twice
elsewhere in this PR),
because each is an instance of the class the rule governs: it asserted `guides/rule-extracts/**`
was `coc-core` (it is `cc`); it located the manifest invariant by a line count in the wrong
direction (cited by grep-stable anchor now, per `symbol-anchored-citations.md` MUST-1 — a count
breaks on the next insertion); and after the tier LABEL was fixed it still carried the
narrower-tier DIAGNOSIS, teaching the wrong cause of its own bug.

This pointer file is RETAINED rather than deleted because `journal/0569` cites this path and
journals are immutable (`rules/journal.md`) — deleting it would strand that citation.
