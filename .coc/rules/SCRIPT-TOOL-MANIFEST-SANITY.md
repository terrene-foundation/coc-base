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
- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer at `/redteam` + Probes `.claude/test-harness/probes/script-tool-manifest-sanity.probes.json` — NOT YET AUTHORED, declared in `phase2-deferrals.json::probe_authorship_deferrals`.
  release-specialist at `/release` run the § Audit Protocol set difference against every manifest in
  the diff's package set and read each member of a non-empty difference. Phase 2 (deferred per
  `trust-posture.md` § Two-Phase Rollout) — no hook detector; audit fixtures land WITH the Phase-2
  detector at `.claude/audit-fixtures/script-tool-manifest-sanity/` per `cc-artifacts.md` Rule 9.
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
