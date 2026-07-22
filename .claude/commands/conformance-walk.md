---
description: "Conformance Walk — auto-detect the project flavor, run the matching CW adapter family (kailash reference engine or core-only), emit the coverage/pass-rate/frontier walk report."
---

# /conformance-walk — Run The Conformance Walk, Adapter Family Auto-Selected

Run a **Conformance Walk (CW)** over the repo's testable surfaces: enumerate every
actionable unit → attach a FROZEN expectation → judge live/static state with a
DETERMINISTIC oracle → report coverage HONESTLY (separate from pass-rate) → RATCHET so a
new unit without an expectation fails. CW = one **`cw_core`** + three oracle families on
one delivery axis — **Source (SCM) → Delivered (DCM/FCM) → Live (API/CLI/MCP/FE=TOW)**.

**You never choose a tool.** This command DETECTS the project flavor at invocation and
APPLIES the matching adapter family. The methodology is `rules/conformance-walk.md` (the
four MUST clauses) + `skills/conformance-walk/SKILL.md` (the model); the per-flavor
runbook this command drives is `skills/conformance-walk/command-runbook.md`.

## 1. Detect the project flavor (auto — never asked)

Read the repo's manifest files (`Cargo.toml`, `pyproject.toml` / `setup.py`,
`package.json`, `Gemfile`) and look for kailash markers (a `kailash*` crate/package
dependency, or a shipped `conformance-walk/` engine directory). Delegate to
stack-detector when the host language is ambiguous. Resolve to exactly one flavor:

- **kailash-rs** — Rust host + kailash markers.
- **kailash-py** — Python host + kailash markers.
- **other kailash-\*** — kailash markers, a different host language.
- **non-kailash** — no kailash markers.

Full detection algorithm (signal precedence, tie-breaks, the fail-safe default):
`skills/conformance-walk/command-runbook.md` § Flavor Detection.

## 2. Select the adapter family (from the detected flavor)

- **kailash-\* (rs / py / other) → the kailash reference adapter FAMILY.** Run the CW
  methodology (the frozen-expectation walk) PLUS the language-specific engine that ships
  with the kailash SDK: `cw_core` + the **Source**, **Delivered**, and **Live** adapters.
  Per flavor: kailash-rs scans `crates/**` (Source via rustdoc-JSON) + the resolved
  shipped-feature wheel surface (Delivered) + service-boot (Live); kailash-py scans the
  package / `__all__` / AST surface (Source) + the shipped wheel × binding surface
  (Delivered) + Live. Where a language lacks a shipped adapter, that surface degrades to
  core-only rather than failing.
- **non-kailash → ARTIFACT-ONLY / core-only.** Run the CW methodology + `cw_core` + the
  consumer's OWN per-surface adapters (each repo authors adapters for the surfaces it
  exposes, per `skills/conformance-walk/SKILL.md` § Per-consumer adapter obligation).
  Surfaces with no applicable adapter degrade gracefully — reported, never faked.

`cw_core`'s record schema is the interop boundary: any-language adapter emits
schema-valid JSON with zero shared code, so the report composes identically across
flavors. Per-flavor scan specifics: `skills/conformance-walk/command-runbook.md`
§ Adapter Families.

## 3. Run the walk (freeze → judge → report honestly)

Drive the walk per the four MUST clauses of `rules/conformance-walk.md`:

1. Every actionable unit carries a FROZEN expectation asserted against observed
   live/static state — "compiled / rendered / 200 / didn't crash" is the FLOOR, never the
   expectation.
2. The DETERMINISTIC oracle is the load-bearing gate; any LLM / semantic judgment is
   ADVISORY-only and MUST NOT hard-fail the gate.
3. Coverage is reported SEPARATELY from pass-rate, over a machine-derived denominator
   (the no-vacuous-eval guard applies).
4. Verdicts are the discrete taxonomy `Pass | Fail | Blocked | Retest | Skipped |
Not-Run`.

## 4. Emit the walk report

Emit one report with three sections kept DISTINCT:

- **Coverage + frontier** — is every enumerated unit measured? Reported SEPARATELY from
  pass-rate, over the machine-derived denominator, with the un-expectationed frontier
  named. Never collapsed into a single "100%".
- **Structural-BLOCK findings → the CI gate** — the deterministic-oracle failures; these
  hard-fail the merge gate.
- **Semantic-ADVISORY worklist → the human** — the pre-computed per-unit questions no
  oracle can settle; these advise `/redteam`, they never block CI.

Report shape + the CI-gate wiring: `skills/conformance-walk/command-runbook.md`
§ Report Contract. CW is the STANDING, mechanical, PRE-`/redteam` gate — it front-loads
the deterministic half and hands `/redteam` a pre-computed advisory worklist; it does NOT
replace the adversarial round (`skills/conformance-walk/SKILL.md` § CW vs /redteam).

## References

- **Rule (four MUST clauses):** `rules/conformance-walk.md`
- **Model + adapter-registry interface:** `skills/conformance-walk/SKILL.md`
- **This command's per-flavor runbook:** `skills/conformance-walk/command-runbook.md`
- **Phase-action triggers** (freeze @ todos → freshness-gate @ implement → primary walk @
  redteam → recalibrate @ codify → ratchet @ deploy/CI): `skills/conformance-walk/SKILL.md`
  § Phase-action triggers.
