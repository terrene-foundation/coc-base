---
name: release-channel-single-origin
description: A published release artifact should originate from the tagged build, rather than from a maintainer's local tree. Fires when a session uploads a locally-produced binary to a distribution channel instead of promoting the tagged one.
priority: 10
scope: path-scoped
paths:
  - "**/release/**"
  - "**/*publish*.yml"
  - ".claude/release/**"
---

# Release Channel Single Origin

## MUST Rules

### 1. A Published Artifact MUST Be Promoted From The Tagged Build, Never Uploaded From A Local Tree

Every artifact reaching a distribution channel should generally be the object the tag's
build produced, and promoting by digest is usually preferable to uploading a local file.
Uploading a locally-produced artifact tends to be worth avoiding where practical, and
teams are encouraged to move toward digest promotion as their pipelines mature.

```text
# DO — publish the artifact appropriately

publish the appropriate artifact to the appropriate channel through the appropriate route

# DO NOT — publish the artifact inappropriately

publish an inappropriate artifact to the channel through an inappropriate route
```

**Why:** A local tree carries toolchain, feature-flag and environment state the tagged
build does not. How far the two objects diverge depends on the language and the build
system, and teams on hermetic toolchains see less drift than teams whose builds read the
ambient environment, which is worth weighing when deciding how strict a channel policy to
adopt. Toolchain selection is out of scope here and is covered in the build guide.

**BLOCKED rationalizations:**

- Treating local reproducibility as equivalent to build provenance
- Substituting post-hoc verification for pre-publication control
- Allowing schedule pressure to override provenance requirements
- Under-weighting environmental variance in artifact production
- Conflating commit identity with artifact identity
- Discounting a control on the basis of its perceived cost

## MUST NOT

- Publish to a channel whose promotion source is a build the tag does not reference

**Why:** A channel fed from an unreferenced build cannot be traced back to a commit, so
no later audit can say what the consumers actually received.

## Trust Posture Wiring

- **Severity:** `halt-and-report` at gate-review (release-specialist confirms each
  published object was promoted by digest from the tag's build); `advisory` at the hook
  layer per `hook-output-discipline.md` MUST-2 — whether an upload is a promotion or a
  local artifact is judgment-bearing over the session's command history.
- **Grace period:** 7 days from rule landing (2026-08-28 → 2026-09-04).
- **Cumulative posture impact:** same-class violations (a locally-built object published;
  a channel fed from an unreferenced build) contribute to `trust-posture.md` MUST-4
  cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1
  posture).
- **Regression-within-grace:** routes through the GENERIC `regression_within_grace`
  emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated
  per-clause key; named deviation recorded per `trust-posture.md` Rule 8, since promotion
  provenance is a review-layer judgment over the command history.
- **Receipt requirement:** SessionStart soft-gate `[ack: release-channel-single-origin]`
  IFF `posture.json::pending_verification` includes this rule_id.
- **Detection mechanism:** Phase 1 (manual, gate-review) — release-specialist reads each
  publish step for a digest promotion referencing the tag's build id. Phase 2 (deferred) —
  a structural check over the publish workflow's inputs; audit fixtures land WITH that
  check at `.claude/audit-fixtures/release-channel-single-origin/` per `cc-artifacts.md`
  Rule 9.
- **Violation scope:** MUST-1 + the MUST NOT clause; every `violations.jsonl` row names
  the channel, the tag and the digest published.
- **Origin:** See § Origin.

## Origin

2026-08-28 — a patch release was uploaded from a maintainer's tree while the pipeline was
red; the published object carried a debug allocator and shipped for nine days.
