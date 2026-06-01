---
name: cc-audit
description: "Audit CC artifacts via a composed gate — mechanical sweep battery (emission, parity, headroom, xref) + adversarial behavioral A/B (baseline + behavioral-claim artifacts) + 4-dimension judgment + sync integrity"
---

# CC Artifact Audit (COC Source)

Reviews all artifacts for quality AND sync correctness. This is the **COC source** version — it audits loom/'s variant system, manifest integrity, and USE template distribution.

For project-level audits in downstream repos, see the USE template version.

**Repo type scope**: loom/ has no project-type subdirectory under `agents/` — it is the authority, not a project. `.claude/skills/project/` exists only as a parser-redirect placeholder (the `project` skill), never as project content. This audit never expects project-artifact subdirectories. (BUILD repos also never have them — those are a downstream-USE-only convention. See `rules/artifact-flow.md`.)

## Your Role

Specify scope: `all`, `fidelity`, `sync`, or a specific file/type.

The rubric is **mechanical + adversarial, composed into one gate** — NOT four disconnected LLM-judgment dimensions. Phase 0 runs deterministic gates FIRST; Phase 1 composes each dimension's mechanical signal with LLM judgment (and, for the highest-blast-radius artifacts, an adversarial A/B); Phase 3 composes everything into one CRITICAL/HIGH verdict. This is the `/cli-audit` executable-gate pattern applied to the CC-artifact surface.

## Phase 0: Mechanical Sweep Battery (deterministic — runs FIRST; a red gate BLOCKS, no LLM judgment overrides it)

Run these and capture exit codes/findings BEFORE any LLM-judgment dimension. Each produces a STRUCTURAL signal that feeds a Phase-1 dimension's mechanical half + the Phase-3 composed verdict.

```bash
node .claude/bin/emit.mjs --all --dry-run            # emission integrity + per-cli×lang headroom_pct (Token-Efficiency signal); exit 0
node .claude/bin/validate-emit.mjs                   # frontmatter / priority / scope / tier validity
node .claude/bin/validate-proximity-band.mjs         # Rule-10 proximity-band on baseline additions
node .claude/bin/validate-xref-integrity.mjs         # cross-references resolve (Competency signal)
node .claude/bin/validate-extraction-history.mjs     # Rule-11 recurrence (per-rule×CLI extraction history)
node tools/cli-drift-audit.mjs                       # cross-CLI parity: 0 CRITICAL (neutral-body byte-identity)

# Hard-limit greps (cc-artifacts.md) — structural caps
awk -F'"' '/^description:/ && length($2)>120 {print FILENAME": agent description "length($2)" chars >120"}' .claude/agents/**/*.md 2>/dev/null
for f in .claude/agents/**/*.md;  do [ "$(wc -l <"$f")" -gt 400 ] && echo "$f: agent >400 lines"; done
for f in .claude/commands/*.md;   do [ "$(wc -l <"$f")" -gt 150 ] && echo "$f: command >150 lines"; done
[ "$(wc -l <CLAUDE.md)" -gt 200 ] && echo "CLAUDE.md >200 lines"

# Probe-coverage (probe-driven-verification.md MUST-4): semantic-property assertions MUST be probe-backed, not regex
grep -rEn 'def (verify|score|assert|check|probe)_[A-Za-z_]*(recommend|refus|complian|respons|intent|semantic|quality|outcome|narrative|reasoning)' \
  .claude/test-harness/ tests/ 2>/dev/null \
  | xargs -I {} grep -lE 'kind:\s*"contains"|re\.(search|match|findall)|str\.contains' {} 2>/dev/null
```

Disposition (STRUCTURAL — an LLM "looks fine" does NOT clear a red gate):

- **Hard gates (green on a clean tree → any non-zero exit = CRITICAL):** `emit.mjs --all --dry-run`, `validate-emit`, `validate-proximity-band`. A `headroom_pct < 10%` floor breach = CRITICAL; a `< 15%` band addition without paired-extraction/named-rationale = HIGH (`rule-authoring.md` Rule 10).
- **`cli-drift-audit`:** CRITICAL row = HIGH (examples-slot WARN is expected divergence, not a finding).
- **NOT-yet-green-on-clean — do NOT gate the audit on their absolute exit code:**
  - **`validate-extraction-history` (Phase-1 exit-2 BY DESIGN):** exits 2 until ≥3 real manual Rule-11 sweep cycles wire Phase-2 enforcement (`trust-posture.md` § Two-Phase Rollout). Treat exit 2 as the expected Phase-1 state, NOT a finding; promote to a hard gate when Phase-2 lands.
  - **`validate-xref-integrity` (DIFF-RELATIVE):** flag only cross-references the audited change INTRODUCES or breaks (compare against `git show main:` baseline) — NEW not-found ref = CRITICAL. Pre-existing baseline noise (audit-fixture intentional fakes under `.claude/audit-fixtures/**`, CLI-name backticks like `bin/coc`, stale skill links); greening it to exit-0-on-clean is tracked at `journal/0182` § "Forest item — validate-xref-integrity greening" (acceptance criteria there) → promote to a hard gate once green.
- **Hard-limit grep hit** = HIGH; **probe-coverage hit** (regex against a semantic-property assertion) = HIGH (structural assertions — file existence, exit code, marker presence — keep regex per `probe-driven-verification.md` MUST-3).

## Phase 1: Fidelity Audit

1. **Inventory**: List all artifacts with file paths and line counts.

2. **Four-dimension audit — each dimension = mechanical signal (Phase 0) + LLM judgment; Effectiveness ADDS an adversarial A/B for in-scope artifacts (see scope note below):**
   - **Competency** — [LLM] precise instructions, knows its domain + [mechanical] `validate-xref-integrity` resolves every referenced artifact.
   - **Completeness** — [LLM] edge cases, handoffs + [mechanical] orphan/parity grep (no undeclared `variants/` file; no eager `__all__`/re-export omission per `orphan-detection.md`).
   - **Effectiveness** — [LLM] reliable behavior, output format specified + [ADVERSARIAL, in-scope only] subprocess A/B per `guides/deterministic-quality/01-rule-authoring-principles.md` (artifact-in-context vs stripped) PROVING the artifact changes the agent's behavior — not asserting it. Out-of-scope artifacts clear Effectiveness on LLM judgment + Phase-0 probe-coverage.
   - **Token Efficiency** — [mechanical ONLY] `emit.mjs` `headroom_pct` from Phase 0. NOT an LLM token estimate. **Curation / Over-Density companion** [LLM, ADVISORY — cc-architect dimension 7 + journal/0193]: load-bearing clauses (`MUST` / `MUST NOT` / routing / output-contract) NOT drowned in non-load-bearing prose; depth extractable to a guide/skill. Disposition: advisory FINDING (recommend extraction) — **NEVER a structural FAIL**. The L3 full-context gate + the semantic dimension-7 judgment are the backstop; a mechanical density-FAIL would false-positive on intentionally-dense rules carrying named length-rationale (e.g. `multi-operator-coordination.md`, `artifact-flow.md`). Over-density is an output-quality risk (the consuming agent's plan degrades), not only a byte-budget concern.

   **Adversarial A/B scope — MECHANICAL trigger, not author-narrated (cost discipline):** the Effectiveness subprocess A/B runs ONLY on (a) `priority:0` baseline rules, OR (b) any artifact this audit MODIFIES whose diff touches a **behavior-shaping line** — an instruction / `MUST` / `MUST NOT` / `BLOCKED` clause / decision-or-routing directive / signature/output-contract line (vs a pure reference / example / typo / formatting edit). The trigger is the DIFF CONTENT, NOT whether the audit narrative happens to claim a behavioral effect — an author cannot dodge the A/B by omitting the assertion (same positive-trigger-over-self-declaration discipline as `cc-artifacts.md` Rule 10 / `value-prioritization.md` MUST-1). The behavior-shaping set is NOT keyword-only: clause (b) ALSO fires on any prose-line edit that changes what the agent is licensed to do, what value/threshold it uses, or what it treats as authoritative (e.g. a reworded instruction with no `MUST` token, `TIMEOUT_MS = 5000` → `500`, a flipped polarity in a rationale). **When the instruction-vs-reference classification is ambiguous, the trigger FIRES** (per `self-referential-codify.md` Rule 2 boundary discipline "edge cases resolve in favor of the gate firing" — the A/B is one subprocess cost; a missed behavior regression is N future sessions). Every other artifact (no priority:0, diff is UNAMBIGUOUSLY reference/example/typo/formatting-only) clears Effectiveness on LLM judgment + Phase-0 probe-coverage — no A/B. Rationale: each A/B is a real LLM-subprocess cost; baseline rules + behavior-shaping diffs are the highest-blast-radius surface where "does it actually change behavior?" MUST be proven, not asserted. (Per `rules/probe-driven-verification.md`: the A/B is the probe; lexical checks are not.)

3. **Hard limits — LLM-judgment half** (the mechanical line/char/frontmatter greps run in Phase 0; here judge the semantic ones): description trigger phrases read as failure-mode language; CLAUDE.md has no _restated_ rules (semantic, not grep-able); rules carry DO/DO NOT examples + Why rationale that actually explain the failure mode.

## Phase 2: Sync Integrity Audit (COC-specific)

6. **Manifest validation** (`sync-manifest.yaml`):
   - Every `variants:` entry has global + variant files on disk
   - Every `variant_only:` entry exists on disk
   - No orphan files in `variants/` undeclared in manifest
   - Every syncable file in a tier (cc/co/coc) or explicitly excluded
   - No contradictions (tier + exclude, or variants + variant_only)

7. **Exclusion verification**:
   - Management agents (sync-reviewer, coc-sync, repo-ops, settings-manager) excluded
   - Management commands (repos, inspect, settings) excluded
   - Meta files (\_README, \_subagent-guide) excluded
   - Per-repo data (learning/) excluded

8. **Authority chain**:
   - `artifact-flow.md` Rule 1 says atelier/ owns CC+CO, loom/ owns COC
   - Consistent with atelier/'s artifact-flow.md? No contradictions?

9. **USE template contamination** (scan every USE template under loom/):
   - Production-import patterns: `grep -rEl "(^|[^_a-zA-Z])(from kailash|import kailash)" .claude/agents/ .claude/rules/` → must be 0 (legitimate doc-citation strings like `Origin: src/kailash/...` are NOT contamination — flag only actual import statements)
   - Management agents must NOT be present (sync-reviewer, coc-sync, repo-ops, settings-manager, todo-manager, gh-manager, posture-auditor)
   - Management commands must NOT be present (repos, inspect, settings, sync, sync-to-build)
   - BUILD-only commands flagged (/release lives in BUILD-only emission scope)

10. **Hook integrity**:
    - Every hook in settings.json has a script on disk
    - Source and template settings.json are consistent

## Phase 3: Report + Convergence (one composed gate)

Compose Phase 0 (mechanical/structural) + Phase 1 (dimensional: mechanical + LLM + adversarial) + Phase 2 (sync integrity) into ONE CRITICAL/HIGH/NOTE verdict — NOT four separate dimension scores. Load-bearing vs corroborating: a red Phase-0 mechanical gate OR a failed Effectiveness A/B on an in-scope artifact is CRITICAL/HIGH **regardless of LLM-dimension judgment** — structural + adversarial signals are load-bearing; LLM judgment corroborates and catches what they miss. Conversely, an LLM-only finding (no structural/adversarial corroboration) is surfaced at reviewer-judged NOTE/HIGH — it is NEVER auto-cleared and NEVER used to _override_ (clear) a structural-red. "Corroborating" means additive-on-top, not ignorable. Run iteratively until zero CRITICAL and zero HIGH remain.
