---
priority: 10
scope: path-scoped
paths:
  - "**/*.py"
  - "**/*.rs"
  - "**/*.rb"
  - "**/Cargo.toml"
  - "**/pyproject.toml"
  - "**/Gemfile"
  - "**/LICENSE*"
  - "**/NOTICE*"
  - "specs/**"
  - "docs/**"
  - "**/CHANGELOG*"
  - "**/README*"
---

# Foundation Independence Rules

<!-- slot:neutral-body -->


Foundation projects are owned by the Terrene Foundation (Singapore CLG). They are independent open-source products with NO structural relationship to any commercial entity. The base variant ships to consumers building arbitrary stacks against Foundation methodology (CO/COC, CARE, EATP, PACT) — those consumers' projects MAY have any commercial posture they choose; the methodology and its sync chain do not.

## No Commercial References In Foundation-Synced Artifacts

MUST NOT reference, compare with, or design Foundation-synced artifacts (rules / agents / skills / commands / specs) against any commercial or proprietary product:

- No proprietary product names, SDKs, runtimes, or frameworks in synced content
- No commercial entities, partnerships, or market positioning in synced content
- No "unlike X", "the open-source version of Y", or "differentiates from Z"
- No "Python port of", "community edition of", or derivative language

**Why:** Commercial references in synced artifacts position the Foundation methodology as derivative, undermining its independent identity and potentially creating trademark or legal entanglement.

**Describe Foundation work on its own terms.** The existence of any other product is irrelevant.

**Correct**: "The CO methodology is the Terrene Foundation's open-source approach to autonomous-execution discipline."
**Incorrect**: "The CO methodology is the open-source version of [product name]."

## Consumer Project Posture Is Out Of Scope

The base variant ships methodology + onboarding artifacts. The CONSUMER project (the repo where `/sync` lands the artifacts) may be commercial, mixed-license, or fully proprietary — that is the consumer's choice. This rule applies to the synced artifacts the Foundation owns, not to the consumer's source code.

**Why:** Without this scope clarifier, base-variant consumers reasonably ask "does my proprietary project violate this rule?" — the answer is no; the rule scopes to the artifact set the Foundation distributes through `loom/`.

## No Proprietary Awareness In Synced Artifacts

- No proprietary file paths, module names, or architecture references inside synced rules / agents / skills / commands
- No "compatibility" or "interop" framing in synced artifacts that designs them around a specific proprietary system
- No revenue models, pricing, enterprise vs community splits in synced artifacts

**Why:** Proprietary awareness in Foundation artifacts creates implicit coupling that constrains future methodology decisions and signals that the methodology serves a specific commercial product.

## Foundation-Only Dependencies (Scope: Methodology Authority)

The methodology authority chain (atelier → loom → USE templates) MUST NOT depend on, import from, or interface with any proprietary SDK. Consumer projects (where the base-variant template is `/sync`-landed) are unaffected by this clause; they may depend on whatever they wish.

**Why:** A proprietary dependency in the methodology chain itself would make every downstream user of CO/COC subject to that vendor's licensing — violating the Foundation's independence charter at the source.

## Design For The Methodology's User Base

All decisions about Foundation-synced artifacts driven by: what CO/COC adopters need, what cross-stack practitioners expect, what the broader community contributes. Never by what any specific commercial consumer does or plans to do.

**Why:** Designing methodology for one commercial consumer rather than the broader adopter community biases the artifact set, making it awkward for the long tail while optimizing for one party.

Third parties may build commercial products on Foundation methodology. The Foundation has zero knowledge of, zero dependency on, and zero design consideration for any such product.

<!-- /slot:neutral-body -->
