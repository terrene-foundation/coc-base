---
priority: 10
scope: path-scoped
paths:
  - "**/*.md"
  - "**/CHANGELOG*"
  - "**/.session-notes"
  - "**/journal/**"
---

# Verify Code-Claims Against Ground Truth Before Durable Write

Durable artifacts — CHANGELOG entries, commit bodies, PR descriptions, docs, specs, codified rules, session notes, journal entries — outlive the session that wrote them. A code-claim written into one (a public API name, a function signature, a set/list/`__all__` count, a class name, allowlist/denylist contents) becomes institutional truth the moment it lands, whether or not it was ever true.

## MUST Rules

### 1. Code-Claims In Durable Artifacts Are Verified Against Ground Truth Before The Write

Any claim about code written into a durable artifact MUST first be verified against ground truth: import the symbol, read the source/wheel, or print the FULL collection. The verifying command runs in the SAME session, at the moment of writing.

```bash
# DO — verify the cited surface before writing the CHANGELOG line
python -c "from kailash.workflow import from_brief"        # ImportError = the claim is false
python -c "import m; print(len(m._DANGEROUS_NODE_TYPES), sorted(m._DANGEROUS_NODE_TYPES))"  # FULL collection

# DO NOT — carry a claim forward from a compaction summary / prior-session framing
# CHANGELOG: "Added from_brief / afrom_brief / from_brief_validate / ..."   ← 4 of 5 never existed
# DO NOT — cite a count read through truncated output
# `... | tail -8` silently dropped the count line + first 4 entries → "8 types" (real floor: 12)
```

**Why:** A durable artifact is read by sessions and users with no way to distinguish a verified claim from a reconstructed one; the verification command costs seconds, the correction PR costs a cycle. Evidence: two correction PRs in one release cycle (#1187, #1188 — see § Origin).

### 2. Two Claim Sources Are Presumed False Until Re-Verified

(a) **Context-boundary reconstructions** — any claim carried across `/clear`, auto-compaction, resume, or sub-agent handoff (same epistemic shape as `zero-tolerance.md` Rule 1c). (b) **Truncated command output** — `tail -N` / `head -N` / `... | head` over the line carrying the cited value silently drops the datum. Writing either into a durable artifact without fresh re-verification is BLOCKED.

```bash
# DO — re-derive after any context boundary; print the FULL collection
python -c "import m; print(sorted(m.__all__), len(m.__all__))"

# DO NOT — trust the summary or the truncated pipe
# "the prior session established the 5-entrypoint surface"   ← reconstruction, presumed false
# grep -A20 '_DANGEROUS' file.py | tail -8                   ← truncation, presumed false
```

**Why:** Compaction summaries paraphrase and invent structure ("5 surfaces" became 5 function names that never existed); truncated pipes are indistinguishable from complete output in the transcript. Both are unfalsifiable at read time — only a fresh ground-truth command is evidence.

### 3. Structural Backstops Confirm AFTER The Write — They Are Not A Substitute

TestPyPI clean-venv import, post-publish verify, CI doc-sweeps, and review gates confirm after the durable write; they are the last line, not the verification. Relying on them INSTEAD of verifying before the write is BLOCKED.

**Why:** The backstop catching the false claim still costs a correction PR and ships the false claim into git history; verifying before the write costs one command and ships nothing false.

**BLOCKED rationalizations:**

- "The summary said so"
- "The prior session established this surface"
- "`tail` is enough to see the shape"
- "I'll verify if something breaks"
- "The count is approximate anyway"
- "The clean-venv check will catch it"

## MUST NOT

- Write an API/symbol/count/membership claim into a CHANGELOG, commit body, PR description, doc, spec, or rule without a same-session ground-truth verification

**Why:** The originating failure mode — both incidents in § Origin were verbatim carry-forwards of unverified claims.

- Treat a verified-then-compacted claim as still verified

**Why:** The compaction boundary erases the verification receipt; the claim is a reconstruction again (Rule 2a).

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (reviewer at /implement + release-specialist at /release confirm every code-claim in the diff's durable artifacts has a same-session verification receipt); `advisory` at any hook layer (lexical claim-detection cannot carry `block` per `hook-output-discipline.md` MUST-2).
- **Grace period:** 7 days from rule landing.
- **Cumulative posture impact:** same-class violations (unverified code-claim in a durable artifact) contribute per `trust-posture.md` MUST-4 (3× same-rule in 30d → drop 1 posture).
- **Regression-within-grace:** trigger key `unverified_durable_code_claim` fires emergency downgrade (1 step) per `trust-posture.md` MUST-4.
- **Receipt requirement:** SessionStart soft-gate `[ack: verify-claims-before-write]` IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 — gate-level reviewer mechanical sweep at /implement + /release: for every API-name / signature / count / membership claim in CHANGELOG / docs / PR-description diffs, demand the transcript's verification command (import, full-collection print, source read). Phase 2 (deferred): hook detector `.claude/hooks/lib/violation-patterns.js::detectUnverifiedDurableCodeClaim` (Stop + PostToolUse(Edit|Write) on durable-artifact paths), advisory; audit fixtures land with the detector under the violation-patterns detectUnverifiedDurableCodeClaim subdir per `cc-artifacts.md` Rule 9.
- **Violation scope:** MUST 1 (verify-before-write), MUST 2 (presumed-false sources), MUST 3 (backstop-as-substitute). Every violation row names the durable artifact + the unverified claim.
- **Origin:** See § Origin.

## Distinct From / Cross-References

- **Extends** `git.md` § "Commit-message claim accuracy" (commit bodies describe only diff-present changes) from the commit surface to the CHANGELOG / docs / rule surface.
- **Same epistemic family as** `zero-tolerance.md` Rule 1c — a carried-forward API claim is structurally unfalsifiable after a context boundary until re-verified.
- **Sibling of** `user-flow-validation.md` (walk before declaring done) — the durable-write verification is the artifact-claim analogue of the user-flow walk.
- **Pairs with** `testing.md` § "Verified Numerical Claims In Session Notes" + § structural-enumeration counts — those govern HOW to produce a number; this rule governs that NO claim lands durable without production.
- **Distinct from** `evidence-first-claims.md` — that rule governs diagnostic / root-cause / anomaly / security claims inline in ANY message; this rule governs code-surface claims (API names, signatures, counts, membership) at durable-write time. Same epistemic family, different trigger domains.

## Origin

2026-05-27 release cycle, two incidents — both caught before consumer impact, each costing an extra correction PR: (1) a CHANGELOG Added section (commit b9b0a71ed) listed 5 `kailash.workflow` functions carried verbatim from a compaction-summary "5 entrypoints" framing; four did not exist anywhere in the package (the "5 surfaces" were 5 frameworks, not 5 functions); caught by TestPyPI clean-venv import, corrected in PR #1187 (commit ec2c99163). (2) The correction PR then documented a denylist as "8 types" (and asserted a member was absent) because a `tail -8` silently dropped the count line + the first 4 alphabetical entries; real floor 12, member present; caught at post-publish verify, corrected in PR #1188 (commit 1a3dab318). Authored path-scoped (durable-write surfaces) per the verify-resource-existence.md scoping precedent; Codex/Gemini delivery defaults to the skill channel per `rule-authoring.md` Rule 7.
