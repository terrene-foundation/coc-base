// ────────────────────────────────────────────────────────────────
// cli_delivery lane-declaration contract — shared resolution primitives
// (#408 AC#5-a contract; extracted to this lib in AC#5-b)
// ────────────────────────────────────────────────────────────────
// Each rule declares HOW the non-CC lanes (Codex/Gemini — which have NO
// `paths:` glob loader) deliver it: an OPTIONAL frontmatter field
// `cli_delivery: baseline | skill-channel | cc-only`.
//
//   - baseline      → always-on in AGENTS.md / GEMINI.md (the priority:0
//                     scope:baseline rules already emitted by getCritBaseline).
//   - skill-channel → on-demand index entry in the rules-reference skill
//                     (the AC#5-b emitter — emit-cli-artifacts.mjs).
//   - cc-only       → genuinely CC-specific; not delivered to Codex/Gemini.
//                     The rule carries `exclude_from:[codex,gemini]` AND/OR is
//                     listed in `cli_emit_exclusions.{codex,gemini}`.
//
// These functions are PURE (no fs, no manifest read) so the derivation is
// unit-testable on synthetic frontmatter bodies. The fs-wiring lives in
// emit.mjs::validateCliDelivery (Validator 18), which feeds the per-lane
// manifest-exclusion booleans computed via the emitter's SHARED loadExclusions
// + matchesAnyGlob — so the validator's verdict provably tracks the real emit.
//
// SINGLE SOURCE OF TRUTH: BOTH emit.mjs (Validator 18) AND emit-cli-artifacts.mjs
// (the AC#5-b rules-reference emitter) import these. A divergent second copy
// would re-open the R1 finding the AC#5-a redteam closed ("share the canonical
// parser, no divergent mirror"). emit.mjs imports FROM emit-cli-artifacts.mjs
// (loadExclusions/matchesAnyGlob), so the reverse import would be circular —
// this lib is the shared dependency BOTH can import without a cycle.
//
// `cli_delivery` is a GLOBAL/neutral frontmatter field like priority/scope
// (cross-cli-parity.md MUST-3): it is identical across CLI emissions and is
// NEVER overridden by a per-CLI variant overlay.

import ruleMetadata from "../../hooks/lib/rule-metadata.js";
export const { CLI_DELIVERY_VALUES, parseExcludeFrom, deriveCliDelivery, checkRuleCliDelivery } = ruleMetadata;
