/**
 * dispatch-contract.js — the PURE decision half of the dispatch-contract guard
 * (`orchestrator-context-economy.md` MUST-5 + MUST-6).
 *
 * Two predicates, deliberately asymmetric in the signal each rests on:
 *
 *   (a) NAMED DISPATCH WITHOUT A PUSH-DELIVERY INSTRUCTION — MUST-6.
 *       A dispatch carrying a `name` creates a PERSISTENT MAILBOX agent. That shape never
 *       auto-returns: it stops, and its output reaches the orchestrator only if the brief told it
 *       to PUSH (`SendMessage` to main). A one-shot "return your findings" contract — correct for
 *       an UNNAMED dispatch, whose final message IS the return value — is a no-op against a mailbox
 *       agent, and the lane reads as idle. The `name` half is STRUCTURAL (a field present in
 *       `tool_input` at this moment and nowhere else); the "does the brief say to push" half is
 *       LEXICAL, which caps the finding at halt-and-report per `hook-output-discipline.md` MUST-2.
 *
 *   (b) WRITE-IMPLYING TASK ROUTED TO A READ-ONLY AGENT — MUST-5.
 *       The tool inventory is read from the target agent's OWN frontmatter `tools:` line — a
 *       PARSED DOCUMENT FIELD, which `hook-output-discipline.md` MUST-5(a) names as a fencing-grade
 *       signal. The trigger half ("does this task imply writing") is lexical prose classification,
 *       so the COMPOSED finding is capped at halt-and-report too. Stated plainly rather than
 *       inflated: only the inventory half is structural, and a detector is no stronger than its
 *       weakest half.
 *
 * BOTH FAIL OPEN. An unresolvable agent type, an unreadable agents dir, a malformed payload, a
 * missing `tools:` line — every one returns null. A guard that guesses when it cannot see produces
 * false positives on exactly the dispatches it least understands, and a noisy advisory is one the
 * orchestrator learns to skip past.
 *
 * NO PROMPT TEXT IS RETAINED. Findings carry a bounded, truncated evidence string; nothing here
 * writes to disk.
 *
 * Origin: `orchestrator-context-economy.md` § Origin (co-owner-directed, 2026-08-16).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The dispatch tools whose `tool_input` this module knows how to read. */
const DELEGATION_TOOLS = ["Task", "Agent"];

/**
 * Tools that let a lane WRITE. An agent lacking every one of these cannot do write-implying work,
 * which is the whole of predicate (b)'s structural half.
 */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "MultiEdit"];

/** Cap on evidence echoed back into a hook advisory. */
const EVIDENCE_MAX = 180;

/**
 * Lexical markers for an explicit PUSH delivery instruction. `SendMessage` is the tool that
 * actually delivers; the prose variants are the shapes a brief legitimately uses to name it.
 * Deliberately NARROW — a false "this brief is fine" (miss) costs one advisory that did not fire,
 * while a false "this brief is broken" (false positive) costs orchestrator trust in every later
 * advisory. Under an asymmetric cost the recall/precision trade goes to precision.
 */
const DELIVERY_INSTRUCTION_RX =
  /\bSendMessage\b|\bsend[- ]?message\b|\bpush\s+(?:your\s+)?(?:findings|results?|report|conclusions?)\b|\bmessage\s+(?:the\s+)?(?:main|orchestrator|parent)\b|\breport\s+back\s+(?:to|via)\s+(?:the\s+)?(?:main|orchestrator|parent|SendMessage)\b/i;

/**
 * Lexical markers for a task that implies PRODUCING or MUTATING a file. Verbs only — a noun like
 * "the write path" is not a mandate to write, and matching it would fire on every code-reading
 * brief about I/O.
 */
const WRITE_INTENT_RX =
  /\b(?:write|create|author|edit|modify|update|patch|implement|refactor|rename|delete|remove|fix|add)\b[^.!?]{0,80}?\b(?:file|files|rule|rules|hook|hooks|test|tests|fixture|fixtures|probe|probes|doc|docs|documentation|script|scripts|manifest|module|function|agent|agents|command|commands|skill|skills|config|schema)\b|\b(?:apply|land|commit)\s+(?:the\s+)?(?:patch|change|changes|edit|edits|fix)\b|\bcreate\s+(?:a\s+)?new\s+file\b/i;

/**
 * Prose that explicitly SCOPES a dispatch read-only. When present the write-intent match is
 * withdrawn: a brief saying "READ-ONLY … do not edit any file" that also says "the rule I am
 * writing" is describing the CALLER's work, not the lane's. Without this arm, investigation briefs
 * — the single most common correct use of a read-only agent — would be the detector's loudest
 * false-positive class.
 */
const READ_ONLY_SCOPE_RX =
  /\bREAD[- ]ONLY\b|\bdo\s+NOT\s+(?:edit|write|modify|create)\b|\bdon't\s+(?:edit|write|modify|create)\b|\bwithout\s+(?:editing|writing|modifying)\b|\bno\s+(?:edits?|writes?)\b/i;

/** Truncate + single-line an evidence fragment so an advisory stays bounded. */
function clip(s, max = EVIDENCE_MAX) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** The dispatch NAME, or "" when the dispatch is unnamed. Structural. */
function dispatchNameOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const n = toolInput.name;
  return typeof n === "string" ? n.trim() : "";
}

/** The requested subagent type, or "" when absent. Structural. */
function subagentTypeOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const t = toolInput.subagent_type ?? toolInput.subagentType;
  return typeof t === "string" ? t.trim() : "";
}

/** The dispatch brief. Both `prompt` and `description` are read; they are one prose surface here. */
function promptOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const parts = [];
  if (typeof toolInput.prompt === "string") parts.push(toolInput.prompt);
  if (typeof toolInput.description === "string") parts.push(toolInput.description);
  return parts.join("\n");
}

/** True when the brief names an explicit push-delivery mechanism. Lexical. */
function hasPushDeliveryInstruction(prompt) {
  return typeof prompt === "string" && DELIVERY_INSTRUCTION_RX.test(prompt);
}

/** True when the brief is explicitly scoped read-only. Lexical. */
function isScopedReadOnly(prompt) {
  return typeof prompt === "string" && READ_ONLY_SCOPE_RX.test(prompt);
}

/**
 * True when the brief implies producing or mutating a file AND is not explicitly scoped read-only.
 * Lexical.
 */
function impliesWrite(prompt) {
  if (typeof prompt !== "string" || prompt === "") return false;
  if (isScopedReadOnly(prompt)) return false;
  return WRITE_INTENT_RX.test(prompt);
}

/**
 * Parse one agent file's frontmatter into `{ name, tools }`. Returns null unless BOTH a `name:` and
 * a `tools:` line are present inside the leading `---` fence — a file we cannot fully parse must
 * not contribute a half-record that later reads as "declares no write tools".
 */
function parseAgentFrontmatter(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let name = "";
  let toolsRaw = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "---") break;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "name") name = m[2].trim().replace(/^["']|["']$/g, "");
    else if (m[1] === "tools") toolsRaw = m[2].trim();
  }
  if (!name || toolsRaw === null) return null;
  const tools = toolsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { name, tools };
}

/**
 * Build `Map<agentName, string[]>` by walking `<root>/.claude/agents/**\/*.md`.
 *
 * Returns an EMPTY map on any failure. An empty map makes every lookup unresolvable, which makes
 * predicate (b) return null everywhere — the fail-open direction. `readAgentInventory` is the only
 * function in this module that touches the filesystem, so the two detectors below stay pure and
 * directly probeable with an injected map.
 */
function readAgentInventory(rootDir) {
  const out = new Map();
  const base = path.join(rootDir || ".", ".claude", "agents");
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) {
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const rec = parseAgentFrontmatter(text);
        if (rec) out.set(rec.name, rec.tools);
      }
    }
  };
  walk(base, 0);
  return out;
}

/**
 * Tri-state, deliberately NOT a boolean: "yes it can write", "no it cannot", "I do not know".
 * Collapsing UNKNOWN into either pole is the non-discriminating-instrument shape — a built-in type
 * (`general-purpose`, `Explore`) has no file under `.claude/agents/`, and reading its absence as
 * "declares no write tools" would fire on the most common dispatch in the repo.
 */
function canWrite(agentType, inventory) {
  if (!agentType || !inventory || typeof inventory.get !== "function") return null;
  const tools = inventory.get(agentType);
  if (!Array.isArray(tools)) return null;
  if (tools.includes("*")) return true;
  return tools.some((t) => WRITE_TOOLS.includes(t));
}

/**
 * MUST-6 — a NAMED dispatch whose brief carries no push-delivery instruction.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectNamedDispatchWithoutDelivery(toolInput) {
  const name = dispatchNameOf(toolInput);
  if (!name) return null; // UNNAMED dispatch auto-returns; the contract does not apply.
  const prompt = promptOf(toolInput);
  if (prompt === "") return null; // Nothing to read; fail open rather than guess.
  if (hasPushDeliveryInstruction(prompt)) return null;
  return {
    rule_id: "orchestrator-context-economy/MUST-6",
    severity: "halt-and-report",
    evidence:
      `named dispatch "${clip(name, 60)}" carries no push-delivery instruction. A NAMED dispatch ` +
      `is a persistent mailbox agent: it never auto-returns, so a one-shot "return your findings" ` +
      `contract delivers nothing and the lane reads as idle. Either instruct it to SendMessage the ` +
      `orchestrator when done, or drop the name and dispatch it unnamed.`,
  };
}

/**
 * MUST-5 — a write-implying task routed to an agent whose declared tools cannot write.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @param {Map<string,string[]>} inventory agent-name → declared tools
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectWriteTaskToReadOnlyAgent(toolInput, inventory) {
  const agentType = subagentTypeOf(toolInput);
  if (!agentType) return null;
  const writable = canWrite(agentType, inventory);
  if (writable !== false) return null; // true → fine; null → UNKNOWN, fail open.
  const prompt = promptOf(toolInput);
  if (!impliesWrite(prompt)) return null;
  const declared = inventory.get(agentType) || [];
  return {
    rule_id: "orchestrator-context-economy/MUST-5",
    severity: "halt-and-report",
    evidence:
      `dispatch to "${clip(agentType, 60)}" implies producing or mutating a file, but that agent ` +
      `declares tools [${clip(declared.join(", "), 80)}] — none of ${WRITE_TOOLS.join("/")}. The ` +
      `lane will halt at the first file-edit boundary. Re-target a write-capable agent, or scope ` +
      `the brief READ-ONLY and do the edits in the orchestrator.`,
  };
}

/**
 * Run both predicates against one dispatch. Returns an array (possibly empty) — never null — so a
 * caller cannot mistake "no findings" for "did not run".
 */
function inspectDispatch(toolName, toolInput, inventory) {
  if (!DELEGATION_TOOLS.includes(toolName)) return [];
  const findings = [];
  const a = detectNamedDispatchWithoutDelivery(toolInput);
  if (a) findings.push(a);
  const b = detectWriteTaskToReadOnlyAgent(toolInput, inventory);
  if (b) findings.push(b);
  return findings;
}

module.exports = {
  DELEGATION_TOOLS,
  WRITE_TOOLS,
  EVIDENCE_MAX,
  clip,
  dispatchNameOf,
  subagentTypeOf,
  promptOf,
  hasPushDeliveryInstruction,
  isScopedReadOnly,
  impliesWrite,
  parseAgentFrontmatter,
  readAgentInventory,
  canWrite,
  detectNamedDispatchWithoutDelivery,
  detectWriteTaskToReadOnlyAgent,
  inspectDispatch,
};
