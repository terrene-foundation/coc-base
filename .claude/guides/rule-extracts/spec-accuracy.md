# Spec Accuracy — Extended Evidence and Migration Playbook

Companion reference for `.claude/rules/spec-accuracy.md`.

## Origin Post-Mortem — 2026-04-21 Phantom Data-Platform Citations

### Setup

- Workspace: `example-workspace/financial-scenario`
- Spec under draft: `specs/scenario-planning-northstar.md` §13 "Scenario Impact Surface" (full 3-statement view: Income Statement + Balance Sheet + Cash Flow + critical grid + Monte Carlo cascade).
- Asks: cite the data-platform accessors that back each metric in the cascade.

### What the agent drafted

The §13 draft cited 8 data-platform accessors as if they existed:

1. metric_1
2. metric_2
3. metric_3
4. metric_4
5. metric_5
6. metric_6
7. metric_7
8. metric_8

### What `/redteam` proved

Audit ran against `analytics_service.py::SUPPORTED_METRICS` (lines 235-261). Empirical surface:

```
SUPPORTED_METRICS = {
  "metric_a", "metric_b", "metric_c",
  "fx_pair_1", "fx_pair_2", "fx_pair_3", "fx_pair_4", "fx_pair_5",
  "rate_metric_1", "rate_metric_2",
  "cost_metric_1", "cost_metric_2", "cost_metric_3",
}
```

**Zero of the 8 cited data-platform accessors existed.** Only 13 unrelated generic metrics (3 base metrics, 5 FX pairs, 2 rate metrics, 3 cost metrics) were actually wired — none matched the 8 cited accessors.

### Lookaway risk that the rule prevents

Had the §13 draft landed:

1. Downstream developers implement the cascade UI against the spec's split-state framing ("data-platform (Phase-2) / scaffold (Phase-1)").
2. Each metric returns its scaffold value at runtime — `0.85` for metric_1, `0.0` for metric_2, etc.
3. UI renders fine — every cell has a number.
4. The Phase-2 switch never gets flipped because nothing is visibly broken.
5. Decision-makers make scenario decisions on plugged-constant data thinking they're consuming data-platform-derived metrics.

This is the **lookaway tombstone** failure mode the rule blocks. The cited symbols becoming a permanent gap-tracker normalizes "spec describes intent, code describes reality" — the exact divergence the rule exists to prevent.

### Bonus finding — plugged Monte Carlo volatility constants

Same audit surfaced 6 hardcoded volatility constants in `monte_carlo_engine.py`:

```
fx_volatility = 0.08            # comment: "industry index"
sector_volatility = 0.45        # comment: "industry domain"
capex_volatility = 0.10         # comment: "industry domain"
ocf_volatility = 0.315
revenue_volatility = 0.20
cost_volatility = 0.15
```

None of the comments derived from historical data or external research. The §13 draft cited these constants as evidence of "Monte Carlo cascade calibration" — same pattern as the phantom data-platform accessors but at the constants layer instead of the accessor layer.

The rule's Rule 1 ("every citation resolves") covers both — phantom function references AND phantom data-source references.

### User directive that motivated the rule

> _"i want accurate and perfect, acknowledging gaps is useless to user. I want you to codify this principle."_

Translated structurally: a spec acknowledging gaps is worse than a spec missing the section entirely, because the gap-acknowledging spec invites lookaway. The rule's Rule 5 ("incremental spec extension") encodes the workflow: implement first, then extend the spec to describe what shipped.

## Migration Playbook — Existing Gap Trackers

When `/redteam` flags a spec section containing a gap tracker (e.g., the `example-workspace/financial-scenario` `§11.2 Phase-1 scaffolds + code-hygiene follow-ups` precedent), the migration is mechanical:

### Step 1: Extract gap-tracker content into the workstream surface

For each gap-tracker bullet:

```bash
# Choose the right surface based on tracker scope:
# - Multi-shard / cross-team work → workspaces/<project>/todos/active/<topic>.md
# - Single-PR follow-up → GH issue (gh issue create)
# - In-flight PR addendum → PR description bullet
```

Carry forward: who's accountable, target window, dependencies. Drop: any "Phase-1/Phase-2" framing — restate as concrete next-shard requirements.

### Step 2: Delete the gap-tracker section from the spec entirely

Don't soften the language. Don't move the section to "Out of scope". Don't preserve as a comment. **Delete.**

Per Rule 3, "Out of scope" sections BOUND the spec; they don't catalog holes within it. A gap tracker masquerading as out-of-scope is still a gap tracker — same lookaway tombstone.

### Step 3: Land both changes in the SAME PR as the first new spec edit

The migration MUST NOT be a "refactor PR" sitting alone. Landing it on its own re-introduces the failure mode (the spec is editable, the next session re-adds gap content because "the section was just removed for hygiene"). Couple it with real spec progress so the migration sticks.

### Step 4: Update `_index.md` if section numbering shifts

If §11.2 deletion shifts §11.3 → §11.2 etc., update `specs/_index.md` references. Renumbering without an index update breaks `specs-authority.md` Rule 1 (lean lookup table).

## BLOCKED Rationalizations — Full List With Why

Each rationalization below has surfaced in code review or `/redteam` rounds. The Why explains why each one is a reframing of the same lookaway failure mode.

### "The accessor will land next sprint"

**Why blocked:** Future tense ≠ present tense. Specs describe today, not next sprint. The accessor lands → THEN the spec extends.

### "Honest about gaps helps the reader"

**Why blocked:** Honesty about gaps is a virtue for journals, PR descriptions, and post-mortems. In a spec, it converts truth surface into roadmap surface, dissolving the distinction users rely on. Readers trust specs to describe what works; readers trust journals to describe what was attempted.

### "The split-state column documents the migration"

**Why blocked:** Migrations belong in `02-plans/` or `workspaces/<project>/02-plans/`. The split-state column makes the spec a planning artifact AND a truth artifact simultaneously — neither role survives.

### "Removing the Phase-2 column loses the roadmap context"

**Why blocked:** The roadmap context belongs in todos / issues / plans where it can be tracked, prioritized, and closed. In the spec it has no lifecycle — it sits there forever, which is precisely how it becomes a tombstone.

### "/redteam will catch unimplemented parts"

**Why blocked:** /redteam runs once. The spec ships with downstream consumers. The rule prevents the gap-tracker from landing in the first place; relying on /redteam catches some violations but accepts others as "review caught it" — which is the slow version of the failure mode.

### "Accessor is in PR review"

**Why blocked:** PR review is not merge. Spec edits MUST follow merged code, not in-flight PRs. Land the accessor PR first; extend the spec second. (Rule 5 — incremental spec extension.)

### "Spec-first lets us align before implementing"

**Why blocked:** Pre-implementation alignment artifacts exist — they're called plans (`02-plans/`) and briefs (`briefs/`). Specs are domain truth. Misusing the spec surface for alignment work corrupts both surfaces.

### "The code is the spec"

**Why blocked:** This rationalization argues the spec layer is unnecessary. If true, delete `specs/`. If false (it is — see `specs-authority.md`), then the spec must remain accurate.

## Relationship to Existing Loom Rules

| Rule                       | What it prevents                                        | Spec-accuracy relationship                                                                         |
| -------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `zero-tolerance.md` Rule 2 | Stubs / placeholders / fake implementations in **code** | spec-accuracy is the **spec-side companion**: same failure-mode class, different surface           |
| `specs-authority.md`       | Specs organized wrong / read at wrong gates             | spec-accuracy is the **content sibling**: organization vs accuracy split                           |
| `autonomous-execution.md`  | Treating tasks as bigger than autonomous capacity       | When a spec section needs gap content, the right move is to **implement the gap**, not document it |
| `rule-authoring.md`        | Rules without DO/DO NOT, Why, BLOCKED rationalizations  | spec-accuracy is itself authored to this standard                                                  |

## Audit Protocol — Full Form

The rule's body ships a 2-step grep + citation-resolution protocol. The full form `/redteam` SHOULD run on spec-touching rounds:

```bash
# 1. Split-state framing scan
rg -in --color=never \
  'phase-?1.*phase-?2|phase-?2.*phase-?1|target.state|promised.*current|current.*promised|scaffold.*later|later.*scaffold|TBD|backend.follow-?up|FE.follow-?up|pending.accessor|to.be.wired|accessor.pending|will.wire|wired.later|placeholder.until|stub.until' \
  specs/ workspaces/*/specs/ 2>/dev/null

# Expected: zero matches. Any hit = HIGH finding requiring migration playbook.

# 2. Citation resolution
# For each spec file, extract every backtick-wrapped symbol or file:line citation:
#   ast.parse the spec content (treat as markdown); collect inline-code spans
#   For each span S that matches /[a-zA-Z_][a-zA-Z0-9_.]*[(\.][a-zA-Z_]/ (callable):
#     run `rg --type py --type rs --type ts -F "$S"` against the project source
#     exit 0 with ≥1 match → PASS
#     exit 1 (no matches) → CRITICAL finding
# For each file:line citation (e.g., `routes/scenarios.py:127`):
#     verify file exists AND line count ≥ cited line → PASS
#     missing file or insufficient lines → CRITICAL finding

# 3. Future-tense verbs in non-changelog sections
rg -in --color=never \
  '\b(will|going to|plan to|upcoming|next sprint|next quarter|future)\b' \
  specs/ workspaces/*/specs/ \
  | grep -vi 'change.log\|history\|previous\|prior'

# Expected: zero matches outside change-log sections.
```

`/redteam` rounds touching spec content MUST run all three sweeps. Findings convert to HIGH (Sweep 1, Sweep 3) or CRITICAL (Sweep 2).

## Cross-References

- Rule body: `.claude/rules/spec-accuracy.md`
- Sister rule: `.claude/rules/specs-authority.md` + `.claude/guides/rule-extracts/specs-authority.md`
- Stub-class companion: `.claude/rules/zero-tolerance.md` Rule 2
- Origin issue: loom #18 (codify spec-accuracy rule)

Origin: 2026-04-21 — `example-workspace/financial-scenario` `/redteam` of spec §13 + 2026-05-01 codification at loom (issue #18 / loom v2.12.0).
