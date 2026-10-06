---
name: release-channel-single-origin
description: A published release artifact MUST originate from the tagged build, never from a maintainer's local tree. Fires when a session uploads a locally-produced binary to a distribution channel instead of promoting the tagged one.
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

Every artifact reaching a distribution channel MUST be the object the tag's build
produced, promoted by digest. Uploading a locally-produced file is BLOCKED, including
when the local tree is at the tag and the checksums are compared afterwards — a comparison
run after the upload cannot un-publish the object it disagreed with.

```text
# DO — promote the tagged build's object by digest

promote sha256:0b41…c7 from build 4821 (tag v2.9.0) to the stable channel

# DO NOT — build locally at the tag and upload the result

cargo build --release at v2.9.0, then upload target/release/kzc to the channel
```

**Why:** A local tree carries toolchain, feature-flag and environment state the tagged
build does not, so two objects from the same commit are routinely different. Promoting by
digest makes the published object the one that was tested.

**BLOCKED rationalizations:**

- "My tree is at the tag, it builds the same thing"
- "The pipeline is red for an unrelated reason and the release is due"
- "I'll compare the checksums after uploading"
- "It's a patch release, the delta is two lines"
- "Rebuilding in CI takes forty minutes for a byte-identical result"
- "I'll re-publish from the pipeline once it is green"

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
