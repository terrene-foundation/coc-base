/**
 * refusal-rule-id-channel — the bound on the refusal rule ids one engine row may
 * report, and the `process.cocRefusalRuleId` channel a hook reports them through.
 *
 * Moved out of lib/hook-engine.js unchanged: hook-engine.js installs the channel
 * from installShims (`installRuleIdChannel(currentRun)`) and reads the bound when it
 * copies a worker's outcome. This module holds the ONE definition of each; the
 * refusal-rule-id-channel suite pins that the property is defined nowhere else.
 */
"use strict";

// How many refusal rule ids one row may report, and how long each may be: a bound on
// what a row can push through the channel, never a judgement of the ids themselves.
const MAX_RULE_IDS_PER_ROW = 16;
const MAX_RULE_ID_CHARS = 120;
/** The engine's own copy of a reported rule-id list: strings only, bounded. */
/** Whether a reported id is one the engine can carry: a non-empty string within the bound. */
function ruleIdCarriable(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_RULE_ID_CHARS;
}

/**
 * Whether a reported id list lost (or would lose) an id: past the count bound, or holding
 * an id the engine cannot carry (over-long, empty, not a string). A list that is not a
 * list at all is lost whole. An absent list (undefined) reported nothing.
 */
function ruleIdsExceedBound(v) {
  if (v === undefined) return false;
  if (!Array.isArray(v)) return true;
  return new Set(v.filter((id) => typeof id === "string")).size > MAX_RULE_IDS_PER_ROW || v.some((id) => !ruleIdCarriable(id));
}

function boundedRuleIds(v) {
  return Array.isArray(v)
    ? v.filter((id) => typeof id === "string" && id).slice(0, MAX_RULE_IDS_PER_ROW).map((id) => id.slice(0, MAX_RULE_ID_CHARS))
    : [];
}

/**
 * Install the channel. `currentRunFn` is the engine's own current-row lookup
 * (hook-engine.js::currentRun); it is read on every call, never captured once.
 */
function installRuleIdChannel(currentRunFn) {
  // The refusal rule-id channel (lib/instruct-and-wait.js::withRuleId): records an id on
  // the CURRENT row only, while it runs; a no-op outside a row. Non-enumerable, so a hook
  // enumerating `process` does not see it.
  Object.defineProperty(process, "cocRefusalRuleId", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function cocRefusalRuleId(id) {
      const run = currentRunFn();
      if (!run || run.done || run.ruleIds.includes(id)) return;
      // An id the engine cannot carry — past the bound, over-long, empty or not a string —
      // is never dropped silently: the row is marked, and the dispatcher reads a marked
      // row's arm as UNKNOWN (R2b M-1: 16 non-arm ids followed by a data-loss arm's id
      // used to shadow the data-loss verdict).
      if (!ruleIdCarriable(id) || run.ruleIds.length >= MAX_RULE_IDS_PER_ROW) {
        run.ruleIdsOverflow = true;
        return;
      }
      run.ruleIds.push(id);
    },
  });
}

module.exports = {
  MAX_RULE_IDS_PER_ROW,
  MAX_RULE_ID_CHARS,
  ruleIdCarriable,
  ruleIdsExceedBound,
  boundedRuleIds,
  installRuleIdChannel,
};
