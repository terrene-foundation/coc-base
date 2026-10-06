---
id: "ISSUE-TRIAGE-ROUTING"
---

# Issue Triage → Upflow Routing (always-loaded)

When triaging a GitHub issue on THIS repo, the agent MUST route it by the repo's CLASS before any disposition.

## MUST: Route Every Triaged Issue By The Repo `type`, Never By Convenience

Read `.claude/VERSION::type` FIRST, then route:

- **`coc-use-template`** → the origination node: `/codify` Step 7b proposal → loom `/sync-from-use` Gate-1 classify → `/sync-to-use` redistributes.
- **`coc-project`** (downstream consumer) → UP to the template pulled from: `/codify` Step 7c PR to the template inbox (primary) OR a Route-A issue on the template (fallback). NEVER file on your own repo (orphan — never pulled upstream); NEVER file on loom (bypasses USE-template review).
- **`coc-build`** → SDK code: cross-SDK FIRST → `/codify` Step 7a.
- **`coc-source`** (loom) → Splits, Never Originates: INGEST via `/sync-from-build` + `/sync-from-use`, Gate-1 classify; never author a local artifact.

NEVER hand-edit loom to "resolve" an issue; NEVER "fix" one by editing a synced artifact locally (Class-A non-durable — rebuilt by `/sync-to-use`). The durable surface is the proposal. Depth (the four classes, Route A/B, origination taxonomy): the paired `issue-triage-routing` skill + `rules/artifact-flow.md` § "Issue Routing By Change Type".

```
# DO — read .claude/VERSION::type, route by class
coc-project issue (COC-method fix) → /codify Step 7c PR to the template inbox
# DO NOT — route by convenience, or originate at loom
COC-method fix authored into loom/.claude/rules/foo.md (loom only splits)
```

**Why:** A `gh` triage never matches the `.claude/**` / `sync-manifest.yaml` / `*.md` globs the path-scoped routing depth sits behind, so only an always-loaded pointer fires at triage time; without it a COC-method fix lands on a code-only lane or an SDK bug on the artifact lane, bypassing the Gate-1 split and losing provenance.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/issue-triage-routing.md`, which every validator reads as part of this rule.
