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

export const CLI_DELIVERY_VALUES = ["baseline", "skill-channel", "cc-only"];

export function parseExcludeFrom(fmBody) {
  const m = fmBody.match(/^exclude_from:\s*\[([^\]]*)\]/m);
  return new Set(
    (m ? m[1] : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Pure, exported so the derivation is testable in isolation (mirrors the
// validateAggregateHeadroom / detectBindingTokenViolations posture).
// `ccOnlyFromCaller` is TRUE iff the CALLER determined the rule is excluded from
// BOTH non-CC lanes — the manifest∪frontmatter union (validateCliDelivery passes
// `excludedBoth`). It is ORed with this function's own frontmatter check so a
// standalone caller passing only the manifest signal still resolves correctly.
export function deriveCliDelivery(fmBody, ccOnlyFromCaller = false) {
  const explicit = (fmBody.match(/^cli_delivery:\s*([\w-]+)/m) || [])[1];
  if (explicit) return { value: explicit, source: "explicit" };
  const scope = (fmBody.match(/^scope:\s*([\w-]+)/m) || [])[1] || null;
  const ef = parseExcludeFrom(fmBody);
  const fmCcOnly = ef.has("codex") && ef.has("gemini");
  if (fmCcOnly || ccOnlyFromCaller) return { value: "cc-only", source: "smart-default" };
  if (scope === "baseline") return { value: "baseline", source: "smart-default" };
  if (scope === "path-scoped") return { value: "skill-channel", source: "smart-default" };
  if (scope === "skill-embedded")
    return { value: "n/a-skill-embedded", source: "smart-default" };
  return { value: null, source: "smart-default" };
}

// Pure per-rule checker — exported so the contract is unit-testable on synthetic
// frontmatter bodies, no temp-file fixtures. The second arg carries PER-LANE
// manifest-exclusion booleans: { codex, gemini } — the validator computes them
// via the SHARED emitter glob matcher so the validator's verdict provably tracks
// the real emit (no divergent second parser).
// Returns: { value, source, lane (report bucket key, null when failing), failures[] }.
export function checkRuleCliDelivery(fmBody, manifest = { codex: false, gemini: false }) {
  const scope = (fmBody.match(/^scope:\s*([\w-]+)/m) || [])[1] || null;
  const ef = parseExcludeFrom(fmBody);
  const codexExcluded = Boolean(manifest.codex) || ef.has("codex");
  const geminiExcluded = Boolean(manifest.gemini) || ef.has("gemini");
  const excludedBoth = codexExcluded && geminiExcluded;
  const excludedEither = codexExcluded || geminiExcluded;
  const { value, source } = deriveCliDelivery(fmBody, excludedBoth);
  const failures = [];

  // (0) Asymmetric non-CC exclusion — the cli_delivery contract treats the two
  //     non-CC lanes SYMMETRICALLY (its only values are baseline/skill-channel/
  //     cc-only; none express "deliver to gemini but not codex"). A rule excluded
  //     from exactly ONE of codex/gemini (via manifest OR frontmatter) would
  //     otherwise resolve to skill-channel and PASS while being genuinely absent
  //     from that one lane — the silent drop one lane over. Fail loud instead.
  if (excludedEither && !excludedBoth) {
    const absent = codexExcluded ? "codex" : "gemini";
    const present = codexExcluded ? "gemini" : "codex";
    failures.push(
      `excluded from ${absent} only (exclude_from / cli_emit_exclusions) but present on ${present} — ` +
        `cli_delivery has no asymmetric-lane value; exclude from BOTH (cc-only) or NEITHER`,
    );
    return { value, source, lane: null, failures };
  }
  // (1) Unresolved lane — the silent Codex/Gemini drop the contract closes.
  if (value === null) {
    failures.push(
      `cli_delivery unresolved (scope:${scope || "MISSING"}) — non-CC lane undeclared; ` +
        `declare cli_delivery explicitly or fix scope`,
    );
    return { value, source, lane: null, failures };
  }
  // (2) skill-embedded rules deliver via their host skill — not lane-routed.
  if (value === "n/a-skill-embedded")
    return { value, source, lane: "n/a-skill-embedded", failures };
  // (3) Value validity (only an explicit bad value can land here).
  if (!CLI_DELIVERY_VALUES.includes(value)) {
    failures.push(`cli_delivery must be ${CLI_DELIVERY_VALUES.join("/")} (got ${value})`);
    return { value, source, lane: null, failures };
  }
  // (4) Explicit-declaration scope consistency.
  if (source === "explicit") {
    if (value === "baseline" && scope !== "baseline")
      failures.push(`cli_delivery:baseline requires scope:baseline (got scope:${scope})`);
    if (value === "skill-channel" && scope !== "path-scoped")
      failures.push(`cli_delivery:skill-channel requires scope:path-scoped (got scope:${scope})`);
  }
  // (5) cc-only ⟺ excluded-from-BOTH (both directions are silent drops the
  //     #408 deliverable closes: cc-only-but-emits, and excluded-but-not-declared).
  if (value === "cc-only" && !excludedBoth)
    failures.push(
      `cli_delivery:cc-only but rule is NOT excluded from codex+gemini ` +
        `(no exclude_from:[codex,gemini], not in cli_emit_exclusions) — would emit to non-CC lanes`,
    );
  if (value !== "cc-only" && excludedBoth)
    failures.push(
      `excluded from codex+gemini (exclude_from / cli_emit_exclusions) but ` +
        `cli_delivery resolves to ${value} — silent drop; declare cli_delivery:cc-only`,
    );

  return { value, source, lane: failures.length ? null : value, failures };
}
