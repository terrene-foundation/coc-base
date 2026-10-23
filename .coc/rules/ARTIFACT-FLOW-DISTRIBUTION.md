---
id: "ARTIFACT-FLOW-DISTRIBUTION"
---

# Artifact Flow — What A Sync May Write

Pointer — **companion**, as cited below, is `.claude/guides/rule-extracts/artifact-flow.md`.

## /sync-to-use Is the Only Outbound Path to Templates

Only `/sync-to-use` at loom/ may write to template repos. No other command or manual process.

**Why:** Multiple outbound paths create untracked divergence between templates, making it impossible to know which version of an artifact is authoritative.

## Variant Overlay Semantics

- **Replacement**: variant exists + global exists → variant wins
- **Addition**: variant exists, no global → added
- **Global only**: no variant → global used as-is

## Distribution-Durability Invariants

Three orthogonal questions gate whether an artifact write is permitted AND survives to every consumer. Collapsing them into one "permission" axis is the **E3 conflation**. Keep the three classes distinct:

- **A — Distribution-durability invariant** — answers "will this write survive the pipeline?"; keyed on distribution mechanics (this section); varies by NEITHER role NOR posture.
- **B — Posture-gated permission** — answers "has this operator earned the trust to act unilaterally?"; keyed on trust-posture L1–L5 (`rules/trust-posture.md`); varies by posture, NOT role.
- **C — Role-scoped capability** — answers "is this within this operator's job?"; keyed on `business_roles` (`rules/multi-operator-coordination.md` §1); varies by role, NOT posture.

**Composition:** `write permitted-and-durable = role_scopes_it (C) AND posture_unlocks_it (B) AND pipeline_preserves_it (A)` — **conjunctive AND independent**. Companion § Distribution-Durability Invariants — Composition.

**Class A is OWNED here; B and C are REFERENCED, not restated** (`specs-authority.md` Rule 9). **Class B** lives in `rules/trust-posture.md`; **Class C** in `rules/multi-operator-coordination.md` §1. Companion § Distribution-Durability Invariants — Where Classes B and C Live.

### The Class-A members (test: "does this write survive the pipeline, regardless of who wrote it?")

A Class-A invariant is a distribution-mechanics fact — **role-blind AND posture-blind**. The six members are each already a MUST / MUST-NOT clause elsewhere in this rule (loom-splits-never-originates · the single outbound path · direct template edits rebuilt away · the BUILD→BUILD prohibition · human classification, automated placement BLOCKED · the Owned-Surface Bound), collected here as the named cross-cutting class. Depth — the six enumerated with their per-member survival rationale — lives in `.claude/guides/rule-extracts/artifact-flow.md` § Class-A Members — Full Enumeration.

Pointer — the six Class-A members cited above as "elsewhere in this rule" span three parts: the splitter-does-not-originate member is the `### loom Splits` clause of `artifact-flow.md`; the BUILD→BUILD prohibition is `artifact-flow-gates.md` § BUILD Repo Rules and that file's closing prohibitions; human classification is `artifact-flow-gates.md` § Human Classifies Every Change; the single outbound path, direct template edits and the Owned-Surface Bound are in this file.

### The consultant's edit-ban is Class A, NOT a Class-C restriction (the E3 reframe)

The workspace spec `specs/01 §4` mis-filed the consultant's template edit-ban under **Class C** (a role restriction). It is **Class A**: a direct template edit is non-durable for EVERYONE. Companion § E3 Reframe — The specs/01 §4 Mis-filing.

- Edit a template `.claude/` directly (surface: template artifact files) — NOT durable (`/sync-to-use` rebuilds); **Class A blocks it**, role-blind.
- Step-7c proposal PR to the inbox (surface: `.claude/.proposals/inbox/`) — durable (ingested, never rebuilt); **Class C** business-consultant capability.

### The Owned-Surface Bound — what a sync may ADD (Class-A member 6, MUST)

loom writes at a target ONLY within the surfaces declared at `sync-manifest.yaml::owned_surfaces` — the list lives THERE and is never restated here (`specs-authority.md` Rule 9). A write to an undeclared path is BLOCKED, and **adding a surface is a CONTRACT change, not a manifest edit**: the entry lands with this clause's review. Every surface outside `.claude/**` MUST carry `opt_in: true` plus an `election:` naming the key the target's opt-in is READ FROM — **default OFF**; `opt_in: false` is permitted for `.claude/**` alone.

```
# DO — declare the surface, default OFF, election named, THEN write it
owned_surfaces: - surface: <path>  opt_in: true  election: <the manifest key that gates it>
# DO NOT — widen by adding a glob and let the mechanism BE the contract
tiers: [..., ".github/workflows/**"]   # now ships to every consumer; nothing declared it
```

**BLOCKED rationalizations:** "it's just another glob in `tiers:`" / "consumers already treat everything loom sends as loom-owned" / "`.claude/**` set the precedent — same act, wider path" / "it's additive, nothing gets overwritten" / "the consumer can delete it if they don't want it" / "on-by-default is fine, the file is inert" / "declaring it is bureaucracy — the manifest already says what ships" / "we'll make it opt-in once someone objects" / "the surface is already there, so this one is grandfathered".

**Why:** The bound was purely MECHANICAL — whatever globs happened to sit in `tiers:` + ALWAYS_INCLUDE — so a surface widened by editing a data file rather than by changing a contract, and no reviewer was ever asked. The silence is survivable while the surface is inert and stops being survivable at the first EXECUTABLE one: a workflow file loom writes is credentialed CI running code the consumer did not author, so a default-ON widening makes it LOOM's act rather than the consumer's.

### Target-Only Paths Are Preserved (MUST)

A path declared at `sync-manifest.yaml::target_owned:` belongs to the TARGET. `/sync-to-use` and `/sync-to-build` MUST NOT overwrite it, purge it, or report it as a `--verify` residual; its `publish:` mode (`committed` / `local_only`) governs whether the target commits it, and there is NO default. `obsoleted:` OVERRIDES preservation — an obsoletion entry overlapping a preserved path MUST carve the exemption against THIS clause, explicitly.

## MUST NOT

- Read a tier match as a statement that an artifact is DISTRIBUTED. `loom_only` is tested at `classifyFile` step 2b, BEFORE tier inclusion at step 5, and `exclude` / `use_exclude` fence again after it. Every claim about what loom writes MUST come from a real `sync-tier-aware.mjs --dry-run --json` PLAN ACTION (`copy`/`overlay` vs a `skip` and its reason), never from glob membership.

- Leave an artifact with NO positive fate. Every file under `.claude/` MUST resolve to shipped-on-a-tier, `loom_only`, or an explicit exclusion; "matches nothing" is an oversight indistinguishable from a decision and MUST NOT be relied on as a fence.

- Edit template repos directly — rebuilt entirely by `/sync-to-use`

**Why:** Manual template edits are overwritten on the next `/sync-to-use` run, wasting effort and creating false confidence that the change is permanent.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/artifact-flow-distribution.md`, which every validator reads as part of this rule.
