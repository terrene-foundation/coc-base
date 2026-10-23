---
id: "ARTIFACT-FLOW"
paths: ["**/VERSION"]
---

# Artifact Flow Rules

Pointer — **companion**, as cited below, is `.claude/guides/rule-extracts/artifact-flow.md`.

## Authority Chain

- **atelier/** — CC + CO authority (methodology, base rules, guides)
- **loom/** — COC authority (SDK agents, specialists, variant system); central splitter/distributor, does NOT originate

USE-template `/codify` proposal origination is the authoritative target flow for COC-artifact improvements. See `guides/co-setup/09-proposal-protocol.md` Step 7b for the manifest contract.

### Repo Classes Map 1:1 To Resolver Logical Keys

The four repo classes bind one-to-one to `bin/lib/loom-links.mjs` logical keys, and cross-repo tooling resolves every target through that resolver — never a positional `~/repos/<name>` / `../<name>` guess (`repo-scope-discipline.md` § MUST NOT). `sync-manifest.yaml::repos.<target>` still owns the logical NAME + tier membership. The canonical sublayout (F61) is a HINT, never a MUST — any layout is supported.

### Ecosystem Forks vs Downstream Consumers

The four repo classes above describe ONE ecosystem (canon). At scale canon coexists with **client ecosystem forks** — a client copies the ENTIRE loom ↔ build ↔ use ecosystem, syncs **upstream-only**, develops **independently**, and decides per-update whether to roll a canon change in (a gated pull, never an auto-merge). A fork is NOT a **downstream consumer**, which pulls from a USE template WITHIN one ecosystem.

Pointer — the Gate-1 Intake Disclosure Scrub, cited above as "§ below", is `artifact-flow-gates.md` § Intake Disclosure Scrub (Gate-1, before placement), a part that does not load on every path this one does.

**Cascade is scoped to the ecosystem.** WITHIN one ecosystem every improvement reaches every member project via Gate-1 classification + each project's own pull cadence (never an auto-push). ACROSS ecosystems there is NO automatic cascade: a fork SEES canon and DECIDES per change (the gated upstream-pull; auto-merge BLOCKED), and never pushes identity or work back. Disclosure is isolated **bidirectionally** at the boundary — no ceremony, sync, deploy or publish may carry one ecosystem's identity into another's committed/shared/public surface. Any cross-ecosystem pull MUST route its surface through the SAME Gate-1 Intake Disclosure Scrub (§ below) — a scrubbed INTAKE, never a trusted merge. The fork→canon direction is a MUST NOT (below).

**Why:** The unscoped "every improvement cascades to ALL projects" promise conflicts with fork-independence — a client that develops independently cannot also receive canon's every change automatically. Scoping cascade to the ecosystem (intra = reaches-all-via-classify+pull; cross = gated upstream-pull the fork controls) resolves the conflict.

**The source of instantiation MUST be clean at rest.** Any repo a client or downstream operator instantiates FROM MUST carry no canon trust-identity at rest — a clone inherits it in its initial commit and object history. The structural fix is SOURCE-PREVENTION: instantiate from a pre-scrubbed client-template edition (`scripts/publish-to-private-template.mjs`), never from a live canon clone; `clean-instantiate.mjs` is a detect-and-remediate backstop, NOT the fence.

**Why:** Instantiation IS a publish — handing a client a template repo is the same disclosure event `publish-to-public.mjs` and the Gate-1/Gate-2 fences already gate for sync/deploy/publish; the template surface is a fourth publish path the same bidirectional-isolation invariant must cover, or a client's very first commit carries canon's identity forward.

### loom Splits, Never Originates

loom MUST act only as the central splitter/distributor. It ingests proposals from the BUILD and USE-template streams via `/sync-from-build` + `/sync-from-use` (Gate 1), splits global vs variant (human classify), and distributes via `/sync-to-use` + `/sync-to-build`. loom MUST NOT originate an artifact change itself.

**Why:** A distributor that also originates has no upstream audit trail — the BUILD-repo or USE-template `/codify` proposal provenance is the only record of why an artifact changed; a loom-originated edit is unattributable and un-reviewable at Gate-1.

### Co-Owner-Directed Origination (narrow, receipt-gated exception)

loom MAY originate a COC-tooling artifact change directly WHEN the change is directed by a co-owner in-session AND a journal `DECISION` entry recording the directive lands BEFORE the edit. The journal entry IS the upstream audit trail the splitter rule otherwise requires. ALL THREE conditions MUST hold; missing any one → the change is an unattributable loom origination and is BLOCKED:

1. **Verbatim directive** — quoted verbatim in the journal `DECISION` entry, never paraphrased or inferred from assent.
2. **Receipt-before-edit** — the entry is committed-or-staged BEFORE the first artifact edit; it is the provenance, not a post-hoc rationalization.
3. **COC-tooling scope only** — CC/CO methodology still routes to `atelier/`, SDK code to a BUILD repo; this exception widens neither. Per-condition elaboration: companion § Co-Owner-Directed Origination — The Three Conditions, Elaborated.

**BLOCKED rationalizations:** see `.claude/guides/rule-extracts/artifact-flow.md` § Co-Owner-Directed Origination — BLOCKED Rationalizations.

**Why:** Without the verbatim + receipt-first + scope conditions, "co-owner directed it" becomes a rubber-stamp that reopens the unattributable-origination failure mode the splitter rule closes; the three conditions keep the carve-out auditable at Gate-1 exactly as a `/codify` proposal is. CC/CO scope is fenced because methodology drift from `atelier/` is a different, wider failure mode this exception MUST NOT touch.

### The Origination Taxonomy — O1 (compliance), O2 (consultant upflow), O3 (BUILD)

Co-Owner-Directed Origination above is the FIRST loom-direct lane, generalized as the **O1 compliance-origination class** (DECISION-7). THREE legitimate origination paths, each with its own audit trail; `loom Splits, Never Originates` protects the AUDIT TRAIL, not the authorship location:

- **O1** — compliance/standard → artifact, authored **directly at loom** by a **platform-engineer**; audit trail = a receipt-first journal `DECISION` naming the **external authority** (regulation/standard/framework + version/clause) as provenance.
- **O2** — consultant artifact improvement → **upflow**, by a **business-consultant**; audit trail = Step-7c proposal provenance (local manifest + inbox PR + relay), QUADRUPLE-fenced. SHIPPED (§ Downstream-Consumer Routing).
- **O3** — SDK capability / bug → **BUILD**, by a **capability-engineer**; audit trail = a BUILD `/codify` proposal, cross-SDK-first. SHIPPED (§ Issue Routing By Change Type).

Pointer — § Downstream-Consumer Routing and § Issue Routing By Change Type, cited in the O2 and O3 bullets, are in `artifact-flow-routing.md`, a part that does not load on every path this one does.

**O1 — the compliance-origination class.** The one legitimate loom-direct origination lane; methodology home `specs/methodology/`. Full framing: companion § The Origination Taxonomy O1 — The Compliance-Origination Class.

**Enforcement is load-bearing — the citation must GOVERN, not merely EXIST.** The journal `DECISION` receipt MUST (a) cite the external authority down to the specific **version + clause/§**, AND (b) state in ONE sentence HOW that clause MANDATES the artifact's content. Both land BEFORE the edit. An uncited OR non-governing "compliance" edit is an unattributable loom origination and is BLOCKED; the other two carve-out conditions (receipt-before-edit + COC-tooling scope) still apply. Why a bare standard name is the agent-producible degenerate case: companion § The Origination Taxonomy O1 — Why The Citation Must Govern.

**Ecosystem scope:** an O1 artifact citing a **tenant-specific (non-public) authority** is ecosystem-private and MUST NOT ride a canon upstream-pull. Detail: companion § The Origination Taxonomy O1 — Ecosystem Scope.

**Why:** Unlike a live co-owner directive (unfabricatable without the human present), a standard citation is agent-producible from training knowledge alone — so "a citation exists" is too weak: O1 must cite a SPECIFIC clause AND show that clause GOVERNS the artifact. Drop the version/clause or the derivation and O1 collapses into the "to-save-a-round-trip" origination the splitter rule blocks.

## MUST NOT

- Push a client ecosystem fork's identity or work back to canon — the canon←→fork relationship is upstream-pull-only (a fork SEES canon via the gated pull; it never writes back)

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/artifact-flow.md`, which every validator reads as part of this rule.
