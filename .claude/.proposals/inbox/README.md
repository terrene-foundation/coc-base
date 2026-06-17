# Downstream Upflow Proposal Inbox

This directory receives COC-artifact improvement proposals from downstream
consumers of this USE template (per `rules/artifact-flow.md` § Downstream-Consumer
Routing — the Step-7c upflow path).

## Contract

- **One file per proposal**: `<date>-<slug>.yaml` (e.g. `2026-06-17-fix-rule-x.yaml`).
- **Schema**: each entry conforms to the **Downstream Upflow Proposal Schema**
  (`.claude/skills/30-claude-code-patterns/sync-flow.md` § "Downstream Upflow
  Proposal Schema (Step 7c)") — hop-level-only provenance, NO consumer-identifying
  fields, artifact-only (no `sdk_version`/`sdk_packages`).
- **Offered via a human-gated PR** adding the single YAML file (per
  `upstream-issue-hygiene.md` MUST-1). No auto-submission.
- **Never edit another proposer's entry** — add your own file only.

## Ingest

This template's `/sync-from-downstream` (Template Inbox Ingest) scrubs +
reviews-as-untrusted-data + dedups each entry, then relays accepted entries into
this template's own `.claude/.proposals/latest.yaml` (Step-7b manifest) with
hop-level provenance (`origin: downstream, via: <this-template>`). The relayed
proposal then flows to loom Gate-1 on the next ingest cycle.

If a consumer cannot fork this template (no PR permission), the fallback is
Route A: file a COC-method issue against this template directly.
