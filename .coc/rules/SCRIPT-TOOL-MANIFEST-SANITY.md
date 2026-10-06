---
id: "SCRIPT-TOOL-MANIFEST-SANITY"
paths: ["**/package.json", "**/pyproject.toml", "**/Cargo.toml"]
---

# Script-Tool Manifest Sanity — A Declared Script Names A Declared Tool

A project manifest's script section is a promise: `npm run lint` will run a linter. The
dev-dependency section is what makes the promise keepable. When the two drift, the script does
not fail loudly — it exits `command not found`, and every gate that does not itself invoke the
script reports green. The defect is invisible in exactly proportion to how thoroughly the tool
would have caught things.

## MUST Rules

### 1. Every Declared Script Tool Appears In Declared Dev-Dependencies

Every named tool a manifest's script section invokes MUST resolve to a declared development
dependency of that same project: a `package.json` `scripts.<X>` value's first token → an entry in
`devDependencies`; a `pyproject.toml` `[project.scripts]` / `tool.poetry.scripts` callable → a
`[dev]` extra or `dev-dependencies` entry; a `Cargo.toml` workspace task naming an external cargo
plugin → a `[dev-dependencies]` entry OR a documented CI install step. Shipping a script whose
first-token tool is absent from the declared dev-dependencies is BLOCKED, and the fix lands in the
SAME PR (`autonomous-execution.md` MUST-4 — same bug class, in budget, context warm).

```jsonc
// DO — the script's tool is declared where the script can reach it
"scripts":         { "lint": "eslint src/" }
"devDependencies": { "eslint": "^9.0.0" }

// DO NOT — a script naming a tool nothing declares
"scripts":         { "lint": "eslint src/" }   // → sh: eslint: command not found
"devDependencies": { }                          // CI green: no gate invokes the script
```

**BLOCKED rationalizations:** "the lint script is rarely run locally, low priority" / "CI doesn't
invoke lint — no blast radius" / "we'll add the dep when someone notices" / "it's a leftover, we'll
delete the script later" / "the tool is globally installed on most dev machines" / "the lockfile has
it transitively — that's enough" / "the gap is pre-existing, not introduced by this PR"
(`zero-tolerance.md` Rule 1 + 1c: pre-existing is not a disposition, and after a context boundary it
is not even provable).

**Why:** A missing dev-dep does not surface as a failure but as a NON-RUN — the tool exits
`command not found` and any gate that does not itself invoke the script reports green, so the
absent check is indistinguishable from a passing one. A transitive lockfile entry is not a
substitute: it is a resolution accident that the next dedupe or minor bump silently removes, and
nothing declares that the project depends on it.

## Audit Protocol (mechanical, at `/redteam`)

Set difference, read as a set and not as a count:

1. Parse the manifest → enumerate each script name and its first-token tool.
2. Parse the dev-dependency section → enumerate declared tools.
3. `(script tools) − (declared dev-deps)` MUST be empty. Any non-empty difference is a HIGH
   finding, one row per member.

Fire the parser at a manifest already known to declare a tool before trusting an empty difference
(`instrument-discipline.md` MUST-3(a)) — an empty result from a parser that never matched anything
is indistinguishable from a clean one, and this check's whole subject is a silent non-run.

At loom, steps 1–3 are mechanical and the firing control is built in:

```bash
node .claude/bin/check-script-tool-parity.mjs --self-check   # the control — run it FIRST
node .claude/bin/check-script-tool-parity.mjs                # the set difference
```

Everywhere else the tool does not exist (§ Trust Posture Wiring → CONSUMER NOTE), so steps 1–3 stay
a hand-run set difference and this rule's silence at that target is the absence of an instrument.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at `/redteam` + release-specialist at
  `/release` run the set difference above and confirm it is empty, with the parser shown to fire);
  `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 — a manifest edit is a
  structural signal but whether a first token is a TOOL or a shell builtin/inline script is
  judgment-bearing, so a lexical detector MUST NOT carry `block`.
- **Grace period:** 7 days from rule landing (2026-08-10 → 2026-08-17).
- **Cumulative posture impact:** same-class violations (a shipped script whose first-token tool is
  absent from the declared dev-dependencies) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace` emergency
  trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key
  (a manifest-parity property is review-layer-plus-advisory-hook and does not warrant an instant-drop
  key; minting one would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into
  a self-referential edit). Named deviation from the canonical key-per-clause shape, recorded here
  per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md`
  § Enforcement-Surface Parity and `git.md` § CI-check/merge took.
- **Receipt requirement:** SessionStart soft-gate `[ack: script-tool-manifest-sanity]` IFF
  `posture.json::pending_verification` includes the `script-tool-manifest-sanity` rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` +
  release-specialist at `/release` run the § Audit Protocol set difference against every manifest in
  the diff's package set and read each member of a non-empty difference. **Probes: REGISTERED —
  `.claude/test-harness/probes/script-tool-manifest-sanity.probes.json`**, 4 rows in 2 bipolar
  `pair_id` pairs — one firing pair for this rule's single derived clause, plus a meta-compliance
  pair — with candidate fixtures + answer-key sidecars at
  `.claude/audit-fixtures/script-tool-manifest-sanity/`. Registered in `eval-manifest.json` as a
  probe-only entry (`scanner: null`) and pinned in `probe-suite-integrity.test.mjs::PINNED_SUITES`;
  ZERO deferred clauses in `clause-coverage-baseline.json`. The firing pair is built so every
  neighbouring rule is SATISFIED in the violating pole — the one empty result it relies on is
  controlled, both reviewers return genuine ran-signals, the head SHA is pinned before the checks
  query, and nothing is deferred — so the ONLY defect is the undeclared tool, and a judge citing a
  neighbour has named the wrong rule. Registration buys DISPATCHABILITY, never automatic execution:
  no workflow invokes `coc-probe-dispatch.mjs`, and the loom↔csq boundary keeps CI LLM-free, so a
  green CI run is NEVER evidence these probes passed — they execute only when an orchestrator
  dispatches `/test-harness-probe --artifacts` at gate-review. Consumer note:
  `.claude/test-harness/**` is never-synced, so no consumer receives this suite and enforcement at
  those targets is gate-review. **Phase 2 has LANDED (2026-09-15) and is NOT a hook** —
  `.claude/bin/check-script-tool-parity.mjs`, a gate-time validator over pure predicates in
  `.claude/bin/lib/script-tool-parity.mjs`, with bipolar structural fixtures at
  `.claude/audit-fixtures/script-tool-manifest-sanity/parity-*` driven by that directory's `run.mjs`
  per `cc-artifacts.md` Rule 9 (MEASURED 22/22, and the set is shown load-bearing by four mutations
  that reddened 10, 3, 6 and 1 case respectively — an all-green fixture set proves only that it ran).
  It runs the § Audit Protocol mechanically: parse each manifest's `scripts`, take the first token of
  every shell segment, and subtract the declared dependency sections and the enumerated ambient set.
  **A HOOK WAS REJECTED ON THE EVIDENCE, not on cost.** This rule's Origin is a manifest that drifted
  on the DEFAULT BRANCH for an unknown duration with nobody editing it; a `PreToolUse`/`PostToolUse`
  detector fires only when a tool call touches a file, so it is structurally incapable of seeing the
  originating incident — the defect's whole signature is a file AT REST. Severity is unchanged from
  § Severity above and is not re-derived here: `halt-and-report`, never `block`, because the verdict
  rests on that ambient allowlist — a judgment about the world rather than a fact read out of the
  manifest — which `hook-output-discipline.md` MUST-2 caps. **WHAT IT CANNOT SEE, so its silence is
  never read as an all-clear (`instrument-discipline.md` MUST-3(a)):** (a) `pyproject.toml` and
  `Cargo.toml`, which are inside this rule's `paths:` and outside the checker — each one found is
  announced as an `unsupported-manifest-kind` NOTICE rather than skipped, and its set difference is
  owed to the § Audit Protocol by hand; (b) whether a declared package actually publishes the bin
  name the script calls, which is install state, not manifest state; (c) a payload behind an
  unmodelled package-manager subcommand or a cross-workspace script reference, each returned as a
  named NOTICE. Run `--self-check` before trusting any empty difference: it drives a known-positive
  and a known-negative manifest through the same predicates and REDS if either pole misbehaves, which
  is the § Audit Protocol's own fire-the-parser-first requirement made executable.
  **CONSUMER NOTE — the checker does NOT ship.** MEASURED with `sync-tier-aware.mjs::buildLaneClassifier`:
  `.claude/bin/check-script-tool-parity.mjs` returns `skip/no_tier_match` on all seven lanes because
  `.claude/bin/**` is `loom_only`, while the control `.claude/bin/burndown-build.mjs` returns
  `copy/always_include` on all seven — so that zero is a readable true negative and not a blanket
  skip. This rule reaches six lanes (`use|build/base`, `use|build/py`, `use|build/rs`; `build/prism`
  is `skip/no_tier_match` for the rule itself). Unlike every other `.claude/bin/**` entry in
  `detector-distribution-baseline.json`, the usual justification does NOT hold here — a consumer
  emphatically DOES have manifests for this scanner to read — so the gap is an OPEN FINDING whose
  remedy is a `sync-tier-aware.mjs::ALWAYS_INCLUDE` entry, never a narrowing of this rule. Until that
  lands, enforcement at those six targets is the Phase-1 gate-review sweep above, and its silence
  there is the ABSENCE OF AN INSTRUMENT rather than evidence that no manifest has drifted.
- **Violation scope:** MUST-1 ONLY. Every `violations.jsonl` row names the manifest, the script, and
  the undeclared tool.
- **Origin:** See § Origin.

Origin: 2026-08-10 — `/sync-from-build` `build.prism` Gate-1 ingest of proposal candidate
`script-tool-manifest-sanity` (stream pinned at blob `6309373`). A frontend package's `lint` script
named a linter that was absent from `devDependencies` for an unknown duration on the default branch;
`npm run lint` exited `command not found` and CI never caught it because no test invoked the script.
The proposal verified the identical shape in Python (a `pytest` entry point with the plugin absent
from `[dev]`) and Rust (a `cargo-make` task naming a missing plugin), which is why this lands GLOBAL
rather than on a language variant. Placed `priority: 10` + `scope: path-scoped` +
`cli_delivery: skill-channel` under the measured saturated-baseline constraint — the same
disposition `handoff-completion.md` and `burn-down-reporting.md` took. It adds zero bytes to every
profile `check-rule-injection-budget.mjs` measures — but read that as "no probe covers this glob
class", NOT as "measured free": none of the eight probe paths is a manifest file, so that suite
would print identical figures whether this rule cost 0 B or 5.6 KB (`instrument-discipline.md`
MUST-1). The negative is real rather than a dead matcher — control: `packages/**` does match the
`runtime.py` probe under the same function.
