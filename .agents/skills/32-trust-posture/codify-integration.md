# /codify Integration — Trust Posture Wiring

`/codify` MUST consult this file when authoring or amending rules. Without the integration, rules ship without enforcement, and the trust system degrades to un-instrumented prose.

## Mandatory Step at /codify

After pattern extraction and before writing the proposal manifest:

### Step N: Trust Posture Wiring (MUST)

For each candidate rule in this codify cycle:

1. **Read** `.claude/learning/violations.jsonl` (last 30 days). Find self-reported / detected violations whose `addressed_by` is null AND whose root cause matches the candidate rule.

2. **Link** addressed violations to the new rule: update `addressed_by: "rules/<file>.md@<sha>"` for each.

3. **Author** the rule's "Trust Posture Wiring" section using `rule-authoring-checklist.md` format. The section MUST include severity, grace days, cumulative threshold, regression-within-grace policy, detection mechanism.

4. **Append** to `posture.json` `pending_verification` array:

   ```json
   {
     "rule_id": "<rule_id>",
     "since": "<ISO ts>",
     "grace_period_days": 7,
     "first_violation": "<vio_id or null>"
   }
   ```

5. **Emit** the proposal to `.claude/.proposals/latest.yaml` per `rules/artifact-flow.md`. The proposal entry MUST include the wiring section verbatim. Proposals lacking wiring are rejected at sync-reviewer Gate 1.

## What's grandfathered

Rules that pre-date the trust-posture system do NOT require retroactive wiring. Mark them with `_grandfathered: true` in violations.jsonl entries. New /codify cycles wire only NEW rules.

## How /codify discovers existing pending_verifications

```bash
node -e "
const {readPosture} = require('.claude/hooks/lib/state-io.js');
const p = readPosture(process.cwd());
console.log(JSON.stringify(p.pending_verification, null, 2));
"
```

## Bootstrapping note

The first /codify cycle that ships a rule under this system did NOT itself follow the wiring step (the skill didn't exist yet). That's the only legitimate exception, recorded as the Phase 1 / Phase 2 split in `rules/trust-posture.md`. Every subsequent /codify cycle MUST wire.

## Integration with cc-architect agent

`cc-architect` is the validation pass at /codify. It MUST grep the proposal for the literal string `## Trust Posture Wiring` and verify the section has all 5 fields. Missing → audit failure → /codify halts.
