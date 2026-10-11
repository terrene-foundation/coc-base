'use strict';

function stripOutsideQuoteComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Split a flow-list body on commas that are OUTSIDE quotes, so a brace-glob's
// internal comma is preserved no matter where the element sits in the list.
function splitFlowListOutsideQuotes(body) {
  const out = [];
  let cur = "";
  let inS = false;
  let inD = false;
  for (const c of body) {
    if (c === "'" && !inD) {
      inS = !inS;
      cur += c;
    } else if (c === '"' && !inS) {
      inD = !inD;
      cur += c;
    } else if (c === "," && !inS && !inD) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

// Trim, unquote a single list item. Comment-stripping is done at the line level
// (stripOutsideQuoteComment) BEFORE this, so no comment handling is needed here.
function stripPathItem(raw) {
  return raw.trim().replace(/^["']|["']$/g, "").trim();
}

function parseRulePaths(fmBody) {
  const lines = fmBody.split("\n");
  const out = [];
  let inList = false;
  for (const rawLine of lines) {
    // Strip any outside-quote trailing comment FIRST — this removes the
    // greedy-vs-bracket ambiguity entirely (a comment can no longer contain a
    // `]` that the bracket match would over-capture).
    const line = stripOutsideQuoteComment(rawLine);
    // Inline flow-list form: `paths: ["a", "b"]`. Greedy to the LAST `]` is now
    // safe (the comment is already gone) and preserves a glob char-class like
    // `**/*.[ch]`. The body is split quote-aware, position-independent.
    const inline = line.match(/^paths:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const t of splitFlowListOutsideQuotes(inline[1])) {
        const g = stripPathItem(t);
        if (g) out.push(g);
      }
      return out; // inline form is self-contained; no block follows.
    }
    if (/^paths:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList) {
      // Full-line comment inside the block: skip, do NOT terminate the list.
      // (A comment-only line is empty after stripOutsideQuoteComment iff the
      // `#` was at column 0 with no preceding space; handle both via trim.)
      if (line.trim() === "" || /^\s*#/.test(rawLine)) continue;
      const m = line.match(/^\s*-\s*(.+?)\s*$/);
      if (m) {
        const g = stripPathItem(m[1]);
        if (g) out.push(g);
        continue;
      }
      // A non-list, non-blank, non-comment line ends the paths block.
      if (line.trim() !== "") break;
    }
  }
  return out;
}


const CLI_DELIVERY_VALUES = ["baseline", "skill-channel", "cc-only"];

function parseExcludeFrom(fmBody) {
  return new Set(parseRulePaths(fmBody.replace(/^paths:/gm, "ignored_paths:").replace(/^exclude_from:/gm, "paths:")));
}

function scalarField(fmBody, field) {
  const line = fmBody.split("\n").find(row => row.startsWith(`${field}:`));
  if (!line) return null;
  const value = stripPathItem(stripOutsideQuoteComment(line).slice(field.length + 1));
  return value || null;
}

// Pure, exported so the derivation is testable in isolation (mirrors the
// validateAggregateHeadroom / detectBindingTokenViolations posture).
// `ccOnlyFromCaller` is TRUE iff the CALLER determined the rule is excluded from
// BOTH non-CC lanes — the manifest∪frontmatter union (validateCliDelivery passes
// `excludedBoth`). It is ORed with this function's own frontmatter check so a
// standalone caller passing only the manifest signal still resolves correctly.
function deriveCliDelivery(fmBody, ccOnlyFromCaller = false) {
  const explicit = scalarField(fmBody, "cli_delivery");
  if (explicit) return { value: explicit, source: "explicit" };
  const scope = scalarField(fmBody, "scope");
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
function checkRuleCliDelivery(fmBody, manifest = { codex: false, gemini: false }) {
  const scope = scalarField(fmBody, "scope");
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

function resolveRuleMetadata(fmBody, manifest = {}) {
  const exclusions = parseExcludeFrom(fmBody);
  const delivery = checkRuleCliDelivery(fmBody, manifest);
  const applicable = !manifest.codex && !exclusions.has("codex") && delivery.value !== "cc-only";
  const legacyUnresolved = delivery.value === null && exclusions.size === 0 && !manifest.codex && !manifest.gemini;
  if (!legacyUnresolved && delivery.failures.length) throw new Error(`invalid rule withholding declaration or delivery contract: ${delivery.failures.join('; ')}`);
  return {
    paths: parseRulePaths(fmBody),
    applicable,
    delivery,
  };
}

function parseManifestCliExclusions(src) {
  const result = { codex: [], gemini: [] };
  let inStanza = false, currentCli = null;
  for (const raw of src.split("\n")) {
    const line = stripOutsideQuoteComment(raw).trimEnd();
    if (/^cli_emit_exclusions:\s*$/.test(line)) { inStanza = true; continue; }
    if (!inStanza) continue;
    if (/^[a-zA-Z_][^:]*:/.test(line)) break;
    const cli = line.match(/^ {2}([a-z]+):\s*$/);
    if (cli) { currentCli = cli[1]; continue; }
    const entry = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entry && Object.prototype.hasOwnProperty.call(result, currentCli)) {
      const value = stripPathItem(entry[1]);
      if (value) result[currentCli].push(value);
    }
  }
  return result;
}

module.exports = {
  parseRulePaths, stripOutsideQuoteComment, splitFlowListOutsideQuotes,
  CLI_DELIVERY_VALUES, parseExcludeFrom, deriveCliDelivery, checkRuleCliDelivery,
  resolveRuleMetadata, parseManifestCliExclusions,
};
