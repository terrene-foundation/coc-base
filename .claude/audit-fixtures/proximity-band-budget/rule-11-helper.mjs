// Rule-11 (rule-authoring.md MUST Rule 11) recurrence-counting helper for
// 2nd-extraction escalation across (rule, CLI) pairs within 30 days.
//
// Phase 1 (this shard): cc-architect's manual sweep at /codify parses journal
// entries into structured records, then calls this helper to count prior
// Rule-10 invocations per (rule, CLI, lang) lane within the rolling window.
// The helper operates on STRUCTURED INPUT (no prose-regex) per
// `probe-driven-verification.md` MUST-2: the schema is the contract.
//
// Phase 2 (F23b-Phase-2 forest item): a future `.claude/bin/validate-extraction-history.mjs`
// will (a) walk journal/*.md, (b) parse each entry's frontmatter + structured
// `Rule-10 disposition` section into the record shape this helper expects,
// then (c) call this helper. The helper itself is shared between Phase 1 and Phase 2.
//
// Origin: journal/0147 (F23b) + journal/0148 (mid-cycle correction).

/**
 * Count prior Rule-10 invocations on the same (rule, CLI, lang) lane within a
 * rolling calendar-day window. Used by Rule 11's Phase-1 detection mechanism.
 *
 * @param {Object} params
 * @param {Array<{date: string, rule: string, cli: string, lang: string, path: string}>} params.entries
 *   Structured Rule-10-invocation records parsed from prior journal entries.
 *   `date` is ISO-8601 (YYYY-MM-DD). `path` is "a" (paired extraction) or "b" (named-rationale exception).
 *   `rule` is the rule filename (e.g., "security.md"). `cli` ∈ {"codex", "gemini"}. `lang` ∈ {"py", "rs", "base"}.
 * @param {string} params.ruleName  The proposal's touched rule filename (matches `entries[].rule`).
 * @param {string} params.cli       The proposal's lane-of-concern CLI.
 * @param {string} params.lang      The proposal's lane-of-concern language.
 * @param {string} params.asOfDate  ISO-8601 date the proposal lands (cutoff anchor).
 * @param {number} [params.windowDays=30]  Rolling window in calendar days.
 *
 * @returns {{ count: number, matches: Array<Object>, fires: boolean }}
 *   `fires` is true when count ≥ 1 (Rule 11's escalation trigger).
 */
export function countPriorRule10Invocations({
  entries,
  ruleName,
  cli,
  lang,
  asOfDate,
  windowDays = 30,
}) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries MUST be an array of structured records");
  }
  if (!ruleName || !cli || !lang || !asOfDate) {
    throw new TypeError("ruleName, cli, lang, asOfDate are all REQUIRED");
  }
  const asOf = new Date(asOfDate);
  if (Number.isNaN(asOf.getTime())) {
    throw new TypeError(`asOfDate is not a valid ISO-8601 date: ${asOfDate}`);
  }
  const cutoff = new Date(asOf);
  cutoff.setDate(cutoff.getDate() - windowDays);

  const matches = entries.filter((e) => {
    // Structural lane match — exact string compare, not regex over prose.
    if (e.rule !== ruleName) return false;
    if (e.cli !== cli) return false;
    if (e.lang !== lang) return false;
    // Calendar-day window — rolling, half-open [cutoff, asOf].
    const entryDate = new Date(e.date);
    if (Number.isNaN(entryDate.getTime())) return false;
    if (entryDate < cutoff) return false;
    if (entryDate > asOf) return false; // entries after proposal date are ignored
    return true;
  });

  return {
    count: matches.length,
    matches,
    fires: matches.length >= 1,
  };
}
