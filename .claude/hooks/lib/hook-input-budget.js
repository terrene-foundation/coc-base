"use strict";

const STDIN_READ_TIMEOUT_MS = 2000;
const RULE_MATCH_TIMEOUT_MS = 1000;
const MATCHER_BUDGET_MS = RULE_MATCH_TIMEOUT_MS;
const NATIVE_CALL_BUDGET_MS = 540000;
const NATIVE_POLICY_BUDGET_MS = 550000;
const DIRECT_HANDLER_TIMEOUT_MS = Object.freeze({ validator: 4000, standard: 10000, sessionStart: 20000 });
const MCP_POLICY_TIMEOUT_MS = 5000;

class HookBudgetExceeded extends Error {
  constructor(operation, boundMs, detail) {
    const name = typeof operation === "string" ? operation : "Hook";
    const bound = typeof boundMs === "number" && Number.isFinite(boundMs) ? boundMs : 0;
    const suffix = typeof detail === "string" && detail ? ` (${detail})` : "";
    super(`${name}: budget refusal; no verdict was reached within ${bound} ms${suffix}; retry once; if it recurs, report this budget and wait for the user.`);
    this.name = "HookBudgetExceeded";
    this.code = "HOOK_BUDGET_EXCEEDED";
    this.boundMs = bound;
  }
}

module.exports = { STDIN_READ_TIMEOUT_MS, RULE_MATCH_TIMEOUT_MS, MATCHER_BUDGET_MS, NATIVE_CALL_BUDGET_MS, NATIVE_POLICY_BUDGET_MS, DIRECT_HANDLER_TIMEOUT_MS, MCP_POLICY_TIMEOUT_MS, HookBudgetExceeded };
