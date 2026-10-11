"use strict";

function sourceCanDeny(source) {
  if (typeof source !== "string") return null;
  if (/\bprocess\.exit\(\s*(?:[2-9]\d*|1\d+)\s*\)|\bexitCode\s*:\s*(?:[2-9]\d*|1\d+)\b|\bisError\s*:\s*true\b|\bseverity\s*:\s*["']block["']|\bpermissionDecision\s*:\s*["'](?:deny|ask)["']|\bcontinue\s*:\s*false\b/.test(source)) return true;
  // Only the literal-output subset below has a negative verdict. Everything
  // else, including imports/helper calls/computed controls, remains UNKNOWN
  // (.claude/codex-mcp-guard/policy-outcome.js:9-28).
  let text = source.replace(/^\s*\/\/[^\r\n]*$/gm, "").trim();
  const fn = text.match(/^function\s+[A-Za-z_$][\w$]*\(\)\s*\{([\s\S]*)\}$/);
  if (fn) text = fn[1].trim();
  let statements = 0;
  while (text) {
    const exit = text.match(/^process\.exit\(\s*[01]\s*\)\s*;?/);
    const output = text.match(/^(?:console\.log|process\.stdout\.write)\(\s*(['"])([^\\\r\n]*?)\1\s*\)\s*;?/);
    if (exit) text = text.slice(exit[0].length).trim();
    else if (output) {
      let json;
      try { json = JSON.parse(output[2]); } catch { return null; }
      if (!json || typeof json !== "object" || Array.isArray(json)) return null;
      if (json.continue === false || json.hookSpecificOutput?.permissionDecision === "deny" ||
          json.hookSpecificOutput?.permissionDecision === "ask" || json.decision === "block" ||
          json.isError === true || json.hookSpecificOutput?.decision?.behavior === "deny") return true;
      text = text.slice(output[0].length).trim();
    } else return null;
    if (++statements > 1024) return null;
  }
  return statements ? false : null;
}

function capabilityMetadata(declarations, source) {
  const scan = sourceCanDeny(source);
  const known = Array.isArray(declarations) && declarations.length > 0 &&
    declarations.every(value => value === "deny" || value === "continue");
  const registry = known ? declarations.includes("deny") : null;
  return {
    registry_can_deny: registry,
    source_can_deny: scan,
    can_deny: registry !== false || scan !== false,
    drift: registry !== null && scan !== null && registry !== scan,
  };
}

function classifyPolicyOutcome(facts, { canDeny = true } = {}) {
  const result = { ...facts, validation: null };
  if (["missing", "timeout", "error"].includes(facts.verdict)) return result;
  const code = facts.exitCode;
  if (!Number.isInteger(code)) return { ...result, verdict: "error" };
  if (code === 2 || facts.continueFlag === false || facts.permissionDecision === "deny") {
    return { ...result, verdict: "deny" };
  }
  if (canDeny !== false && code !== 0) {
    return { ...result, verdict: facts.hasParseableDecision ? "warn-denied" : "crash" };
  }
  if (facts.permissionDecision === "ask") {
    if (canDeny !== false) return { ...result, verdict: "ask-denied" };
    return { ...result, verdict: "surface", validation: facts.validation ||
      'Hook requested user confirmation (permissionDecision:"ask"); review before relying on it.' };
  }
  // A swallowed crash that exits zero still forwards here until per-run records
  // are wired; this branch is .claude/codex-mcp-guard/policy-outcome.js:62-66.
  if (code === 0) {
    return facts.actionableValidation
      ? { ...result, verdict: "surface", validation: facts.validation }
      : { ...result, verdict: "allow" };
  }
  return { ...result, verdict: facts.hasParseableDecision ? "warn" : "crash" };
}

module.exports = { sourceCanDeny, capabilityMetadata, classifyPolicyOutcome };
