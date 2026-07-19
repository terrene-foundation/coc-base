---
name: issue-triage-routing
description: "Issue-triage upflow depth: the four repo classes, Route-A issue vs Step-7c upflow, the origination taxonomy, and the durable-proposal lifecycle. Use when triaging a GitHub issue."
---

# Issue Triage → Upflow Routing — Depth Reference

The always-on routing MUST lives in `rules/issue-triage-routing.md` (read
`.claude/VERSION::type` → route by class). This skill carries the on-demand
depth: how each repo class routes, the two upflow paths (Route-A issue vs the
Step-7c PR), the origination taxonomy, and why the durable surface is always
the proposal — never a local artifact edit. The authoritative mechanics live in
`rules/artifact-flow.md` § "Issue Routing By Change Type"; this skill is the
triage-time companion that resolves the class → lane decision.

## The Discriminator: Route By Change TYPE, Not Repo Convenience

Every artifact-or-code issue routes by the TYPE of change it requests:

- **COC-artifact improvement** (method, rules, skills, agents, COC-tooling) →
  the USE-template lane → a proposal via `/codify` Step 7b.
- **Bug / code / feature / code-improvement** (SDK code) → the BUILD lane →
  cross-SDK FIRST, then a proposal via `/codify` Step 7a.

Routing by repo convenience (a COC-method fix filed on BUILD; an SDK bug filed
on a USE template) puts the change on the wrong lane — it never becomes the
right kind of proposal, and the Gate-1 global-vs-variant split is bypassed.

## The Four Repo Classes (read `.claude/VERSION::type`)

| `type`             | Role                | A triaged issue routes to…                                                                                        |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `coc-use-template` | origination node    | `/codify` Step 7b proposal → loom `/sync-from-use` Gate-1 → `/sync-to-use` redistributes                          |
| `coc-project`      | downstream consumer | UP to the template pulled from: `/codify` Step 7c PR to the template inbox (primary), or Route-A issue (fallback) |
| `coc-build`        | SDK code            | cross-SDK FIRST → `/codify` Step 7a proposal                                                                      |
| `coc-source`       | loom (splitter)     | INGEST via `/sync-from-build` + `/sync-from-use`, Gate-1 classify — never originate a local artifact              |

### `coc-use-template` — the origination node

A USE template (`kailash-coc-claude-py`, `kailash-coc-claude-rs`,
`kailash-coc-py`, `kailash-coc-rs`) is the ONLY repo class that originates
proposals to loom. A COC-artifact issue filed here — or an owner-filed Route-A
downstream filing on its behalf — is consolidated by `/codify` Step 7b into a
proposal in `.claude/.proposals/`, which loom `/sync-from-use` ingests (Gate-1
classify: global vs variant) and `/sync-to-use` redistributes on the next
cycle. Downstream consumers pull on their own cadence.

### `coc-project` — the downstream consumer (Route A vs Step 7c)

A downstream consumer is any repo that pulled COC artifacts FROM a USE template
(end-user project repos, kaizen-cli-py, kz-engage, and every consumer of the
canonical USE-template set). It routes COC-method improvements UP to the
template it pulled from — NOT to its own repo, NOT to loom — via two paths:

- **Primary — Step 7c upflow (push-only, human-gated):** the consumer's own
  `/codify` Step 7c originates a proposal and offers it as a HUMAN-GATED PR to
  the template's `.claude/.proposals/inbox/<date>-<slug>.yaml`. The template's
  `/sync-from-downstream` scrubs + reviews-as-data + dedups + relays accepted
  entries into its OWN Step-7b manifest with hop-level provenance
  (`origin: downstream, via: <template-slug>` — never consumer-identifying).
- **Fallback — Route A (issue on the template):** for no-fork-permission or
  stale (pre-7c) consumers, file a COC-method issue against the USE template;
  the template's `/codify` originates the proposal per Step 7b. Retained, but
  the fallback — not the default.

**Never file on your own repo:** the consumer's Step-7c manifest is push-only
(never pulled by loom or the template), so an own-repo issue documents a
problem nobody upstream ever sees — an orphan proposal. **Never file on loom
directly:** that skips the USE-template-side review that catches
variant-vs-global misclassification before it reaches every OTHER consumer.

### `coc-build` — SDK code, cross-SDK-first

A bug / feature / code-improvement on SDK code is filed against the BUILD repo,
which considers cross-SDK FIRST (does the sibling SDK share the shape / fix?),
then originates a proposal via `/codify` Step 7a.

### `coc-source` — loom Splits, Never Originates

loom acts only as the central splitter/distributor. It ingests externally
originated proposals via `/sync-from-build` + `/sync-from-use` (Gate 1), splits
global vs variant (human classify), and distributes via `/sync-to-use` +
`/sync-to-build`. A triaged issue at loom is classified, never authored into a
local artifact. A distributor that also originates has no upstream audit trail
— the BUILD-repo or USE-template `/codify` proposal provenance is the only
record of why an artifact changed.

**Narrow exceptions (receipt-gated):** loom MAY originate directly under the
Co-Owner-Directed Origination carve-out (verbatim directive + receipt-first
journal `DECISION` + COC-tooling scope) OR the O1 compliance-origination class
(external standard cited down to version + clause, GOVERNING the artifact). Both
substitute a durable provenance receipt for the missing proposal; details in
`rules/artifact-flow.md` § "Co-Owner-Directed Origination" + "§ The Origination
Taxonomy".

## The Origination Taxonomy (O1 / O2 / O3)

Three legitimate origination paths, each carrying its own audit trail; "loom
Splits, Never Originates" protects the AUDIT TRAIL, not the authorship location:

- **O1 — compliance/standard → artifact, authored directly at loom**
  (platform-engineer; receipt-first journal `DECISION` naming the external
  authority + version/clause as provenance).
- **O2 — consultant artifact improvement → upflow** (business-consultant;
  Step-7c proposal provenance, QUADRUPLE disclosure-fenced).
- **O3 — SDK capability / bug → BUILD** (capability-engineer; BUILD `/codify`
  proposal, cross-SDK-first).

## Why The Durable Surface Is The Proposal, Not A Local Edit

NEVER hand-edit loom directly to "resolve" a triaged issue, and NEVER "fix" one
by editing a synced artifact locally. A synced `.claude/**` artifact at a
consumer is Class-A non-durable — it is REBUILT by the next `/sync-to-use`, so a
local edit is silently overwritten. The proposal (`/codify` Step 7a/7b/7c) is
the only durable surface: it carries the Gate-1 audit trail, survives the sync
rebuild, and cascades to every consumer. A local artifact edit does none of
these.

## Cross-References

- `rules/issue-triage-routing.md` — the always-on routing MUST (the pointer).
- `rules/artifact-flow.md` § "Issue Routing By Change Type" / "Downstream-Consumer
  Routing" / "loom Splits, Never Originates" / "The Origination Taxonomy" — the
  authoritative mechanics.
- `rules/knowledge-cascade-routing.md` — the memory-vs-COC-artifact capture
  routing decision (a sibling routing rule, one layer in).
- `guides/co-setup/09-proposal-protocol.md` Step 7b — the proposal-origination
  target flow.
