---
priority: 10
scope: path-scoped
paths:
  - "deploy/**"
  - "**/.last-deployed-*"
  - "**/.last-smoke-result-*"
  - "**/.last-interactions-smoke-result-*"
  - "**/state-file-write-guard.*"
  - "**/validate-state-file.*"
  - "**/post-deploy-smoke.*"
---

# State-File Write Guard — Validator-Driven Deploy Claims

See `.claude/guides/rule-extracts/state-file-write-guard.md` for full BLOCKED-rationalization corpus, extended DO/DO NOT examples (override-ordering JS, atomic-update protocol steps), composition table, and Origin post-mortem.

A project's deploy state file is the canonical signal for whether a deploy is GREEN. Agents producing GREEN claims based on judgment ("page loaded, no console errors") rather than a wrapper-validated contract scan ship false-GREEN at high frequency: the contract scan catches AI-panel stubs, missing data, partial subsets, and silent backend degradation that surface signals miss.

The agent does NOT decide whether a deploy is GREEN — the validator does. The agent runs the validator (or its wrapper), reads the verdict, and writes accordingly. Pure-text rules at write time are demonstrably insufficient — the structural defense (PreToolUse hook + verdict-tier matrix + signature mechanism) closes the bypass. Loom ships the canonical pattern as a parameterized library: `hooks/lib/state-file-write-guard.js` (verdict tier classifier T1/T2/T3/T4 + signature emitter + override env-var check + honest-YELLOW gap validator) plus `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the three-layer Bash mutation coverage. Both are pure logic with no project-specific assumptions; consumers supply a config (state-file shape field names, override env-var name, smoke + interactions report content, contract-scan verdict shape) the lib consumes. Project-specific surface (path globs, validator binary, contract spec, smoke spec) lives in the consumer; the invariant pattern lives at loom.

## MUST Rules

### 1. Hand-Writing Deploy State Without The Wrapper Is BLOCKED

The agent MUST NOT hand-write a project's deploy state file via the Write tool unless the JSON content carries a verdict-tier-validated signature (T1 GREEN or T2 honest-YELLOW per Rule 2). Projects with the discipline enabled enforce structurally; projects without the hook MUST treat this rule as the prose contract.

```bash
# DO — wrapper writes signed file; agent's Write echoes that content
bash scripts/smoke/run-post-deploy-smoke.sh <env>
# DO NOT — hand-craft the JSON and Write it (T3 BLOCK + remediation)
```

**Why:** Judgment-based GREEN claims ship false-GREEN at high frequency because surface signals (page-loaded, no console errors) do not see contract-level gaps (AI-panel stubs, partial data). The wrapper's contract scan IS the verification.

### 2. Tier Matrix — The Validator Decides, Not The Agent

Projects route every protected Write/Edit through a project-supplied validator running in `--mode=hook`. The validator returns one of four tiers via `hooks/lib/state-file-write-guard.js::tierClassify({...})`; the hook acts on the tier, not on agent intent:

| Tier                       | Condition                                                                                        | Hook decision      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ |
| **T1 — Verified GREEN**    | signature valid + contract scan passes + zero prohibited stubs                                   | ALLOW              |
| **T2 — Honest YELLOW**     | `verification_status: "YELLOW"` AND every gap explicitly enumerated                              | ALLOW              |
| **T3 — Unsupported claim** | `"GREEN"` BUT signature missing/invalid OR contract scan fails                                   | BLOCK + diagnostic |
| **T4 — Hook bypass**       | Edit/Write against the structural defense, contract docs, or trust root, OR Bash mutation of any | BLOCK + escalate   |

T3 diagnostic surfaces THREE remediation paths: (a) re-run wrapper to verify GREEN, (b) write YELLOW with enumerated gaps per Rule 3, (c) take the project's documented remediation step then path (a).

**Why:** Each "validator is wrong, override and continue" rationalization is the precise failure mode the tier matrix prevents. If the validator is wrong, fix is to update the contract artifacts atomically (Rule 7), not bypass once. Bypassing teaches the agent the gate is negotiable, which it is not.

### 3. Honest YELLOW Acceptance Criteria

A `verification_status: "YELLOW"` write is accepted iff: (1) the project-defined gap-list field is non-empty; (2) every contract gap surfaced by the smoke / contract scan is enumerated; (3) each entry references the failing identifier (free-text rationale fine; the identifier MUST be present).

```json
// DO — honest YELLOW with enumerated gaps + identifiers
{ "verification_status": "YELLOW",
  "<gap_list_field>": ["<failing-id-1> degraded; tracked in #N", "<failing-id-2> partial; tracked in #M"] }
// DO NOT — claim YELLOW without enumerating
{ "verification_status": "YELLOW", "<gap_list_field>": ["some things are degraded"] }
```

**Why:** YELLOW is the honest acknowledgement of a partially-broken deploy. Without per-gap enumeration referencing the specific failing identifier, the next session inherits an unfalsifiable "things are kinda working" state and the gaps cascade.

### 4. Trust Root Protection — Smoke Reports Are Wrapper-Only

The validator's signature is `sha256(state-file-without-signature || smoke-report || interactions-report)`. Forgeable smoke reports = forgeable signatures = forgeable GREEN. The hook MUST T4-block direct Write/Edit on the project's smoke-report paths AND T4-block Bash mutation of those paths.

```bash
# DO — wrapper produces both reports + state file in one atomic run
bash scripts/smoke/run-post-deploy-smoke.sh <env>
# DO NOT — hand-edit the smoke report so the validator signs forged GREEN
```

**Why:** Closing only the state-file door while leaving the trust-root door open is the same failure mode at a more dangerous level — agent who could not write GREEN directly can hand-write the smoke report (no protection), then run `validate-state-file --mode=emit-signature` (allowed; wrapper-driven), shipping a "signed" state file built on fraudulent signature input.

### 5. Bash-Layer Mutation Coverage — Three Layers

The Bash-side detection MUST cover three layers, not just shell redirects:

- **Layer 1**: redirect / heredoc / `tee` / `sed -i` / `jq -i` / `cat <<EOF >`.
- **Layer 2**: `cp`, `mv`, `dd of=`, `rsync`, `install`, `truncate`, `ln`, `chmod`, `chown`, `touch`.
- **Layer 3**: interpreter `-c` / `-e` / `-m` bodies (`python`, `node`, `ruby`, `perl`, `bash`, `sh`).

Projects opting in MUST consume the shared helper at `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` rather than hand-rolling per-project bash regexes; per-project hand-rolls drift from the shared coverage as new bypass classes emerge. The file-tool path (Write/Edit) routes through `hooks/lib/state-file-write-guard.js::tierClassify({...})` — same shared-lib discipline for the same drift reason.

```bash
# DO — read via cat/jq/grep (no layer matches); use wrapper for writes
cat <state-file>
# DO NOT — Layer 2/3 bypass redirect-only detection
cp /tmp/forged.json <state-file>             # Layer 2 BLOCK
python -c "open('<state-file>','w').write('{}')"  # Layer 3 BLOCK
```

**Why:** Layer 2 and Layer 3 silently bypass redirect-only detection. A `cp /tmp/forged.json <state-file>` accomplishes the exact same forgery as `cat <<EOF > <state-file>`. Cost of Layer-3 false-positive is "use cat instead" — tiny — vs cost of Layer-2/3 false-negative (forged GREEN ships) — the entire failure mode this guard exists to close.

### 6. Override Env-Var Is Checked FIRST

The override env-var (e.g. `<PROJECT>_HOOK_OVERRIDE_STATE_GUARD=1`) MUST be checked at the top of every routing function (file-tool path AND bash path), BEFORE any T4 / T3 / signature / contract-doc check. SELF-first ordering makes the rule-promised escape hatch dead code for hook-self / contract-doc / smoke-report edits.

```javascript
// DO — override checked first; covers every protected category
if (process.env.OVERRIDE_ENV_VAR === "1") return { block: false, tier: "OVERRIDE" };
if (HOOK_SELF_PATTERNS.some(...)) return { block: true, tier: "T4" };
// DO NOT — SELF check first (override never reached for SELF paths)
```

**Why:** Check-order makes the documented override either live or dead. SELF-first makes "set the override env var to perform an atomic update" a contradiction — the only path becomes stripping the hook from settings.json (unprotected), performing the update, and restoring the hook — desynchronizes documented contract from enforced behavior.

### 7. Override Protocol — Atomic Updates Only

To update the contract (add/remove a prohibited string, add a new identifier, change tier semantics): edit the project's contract spec + smoke manifest + smoke spec + validator + hook + rule instantiation + regression suite atomically in ONE commit. The override env-var bypasses the hook for the duration set in the hook environment (via `.claude/settings.local.json` env block, OR strip-and-restore on `.claude/settings.json` with net-zero diff).

Using the override MUST be authorized in chat by the user AND followed by a same-session commit covering all artifacts in lockstep. Leaving the override active across sessions is BLOCKED.

**Why:** The override exists for genuine atomic-update commits, not workflow convenience. Each use must be in-session, authorized, and bounded — same discipline as `--no-verify` on git commits.

## MUST NOT

- Skip the wrapper because the smoke "would pass anyway"

**Why:** Pre-emptively asserting the smoke would pass is the same judgment-based reasoning that produces false-GREEN. The contract scan catches what the agent's walk does not.

- Modify the validator, hook, rule, spec, manifest, smoke spec, or regression test without updating the others atomically

**Why:** The artifacts form a contract. Drift between any two opens the gap that the contract closes.

- Suppress prohibited contract strings to make the smoke pass

**Why:** The prohibited list is the structural ban. Hiding stubs to pass the smoke is the precise fraud the gate exists to prevent.

- Hand-write the smoke report to forge a signed state file

**Why:** The smoke report is the validator's trust root. The signature attests the wrapper produced these reports; bypassing the wrapper invalidates the entire mechanism.

## Trust Posture Wiring

- **Severity:** `block` for projects that wire the structural hook (env-var override is the documented escape hatch); `advisory` for projects without a hook (rule is prose discipline).
- **Grace period:** N/A — baseline rule landed by global emission, not newly-authored for this repo. Per-project enforcement begins when the project wires the hook.
- **Regression-within-grace:** N/A at the global rule layer (no grace). Project-specific instantiations adopt their own grace + regression policy when wired. A consumer that ships the hook then later ships a Write/Bash bypassing it triggers `regression_within_grace` per `trust-posture.md` MUST Rule 4 — emergency downgrade L5→L4.
- **Cumulative threshold:** T3 unsupported-claim detections log to the shared `violations.jsonl` per `trust-posture.md` MUST Rule 4 cumulative path (3× same-rule in 30d → drop one posture; 5× total in 30d → drop one posture).
- **Receipt requirement:** none at the global rule layer. Project-specific instantiations MAY require `[ack: state-file-write-guard]` on first edit of a protected path; project's call.
- **Detection mechanism:** project-supplied PreToolUse hook calling `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the bash layer + `hooks/lib/state-file-write-guard.js::tierClassify(...)` for the file-tool layer + project-supplied validator producing the `contractScanResult` input.

## Composition

This rule is the **per-deploy claim** layer; `rules/trust-posture.md` is the **per-repo authority** layer. T3 unsupported-claim detections log to the shared `violations.jsonl`; cumulative T3 violations cross the trust-posture downgrade threshold and the agent's repo-wide authority degrades on the next session. The deploy claim being blocked is the single-event defense; the posture downgrade is the cross-session learning.

## Cross-references

- `rules/trust-posture.md` — composition partner (per-repo authority layer)
- `rules/zero-tolerance.md` Rule 3 — silent-fallbacks parent class
- `rules/hook-output-discipline.md` MUST-2 — block-severity structural-signal requirement
- `.claude/hooks/lib/violation-patterns.js::detectStateFileMutation` — shared three-layer Bash-side helper
- `.claude/hooks/lib/state-file-write-guard.js` — parameterized file-tool tier classifier + signature emitter + override + gap validator
- `.claude/test-harness/tests/state-file-write-guard.test.mjs` — 36-case structural regression suite (25 baseline + 11 round-2 redteam fixes)

Origin: 2026-05-05 — false-GREEN deploy claim; v1 hook self-redteam surfaced four follow-up gaps (Layer 2/3 bash, smoke-report trust root, contract-doc protection, override-ordering); v2 closed them. Issue #25 (loom) endorsed global adoption; PR #125 (2026-05-10) lifted the institutional-knowledge layer (this rule) + Bash-side helper. Subsequent lift (2026-05-10): the parameterized file-tool library `state-file-write-guard.js` lifted at loom per the loom-distillation principle (loom owns canonical global patterns, not consumer-specific implementations). Project-specific surface (path globs, validator binary, contract spec, smoke spec) stays at the consumer. See guide for full post-mortem.
