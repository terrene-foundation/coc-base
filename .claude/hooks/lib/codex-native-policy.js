/** Native PreToolUse adapter. Reuses the delivered policy evaluator; an MCP
 * server registration by itself cannot intercept native tools. The expanded
 * target registration inventory also covers wildcard and MCP/local-function
 * policies which the historical three-tool policy table cannot represent.
 */
"use strict";
const { readExpandedSettings, hookBasename } = require("./dispatch-registry");
const { matcherMatchesWithoutRegex, mergeOutcomes } = require("./hook-engine");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, NATIVE_AGENT_TOOLS, NATIVE_SHELL_TOOLS, normalizeNativeInput, normalizeOutput, refusal, parseOutput } = require("./codex-hook-runtime");
const guard = require("../../codex-mcp-guard/server");
// DERIVED from the runtime's ONE shell-tool set (LOW c, security round):
// adding a tool there extends this table instead of leaving a second list to
// drift. The guard's policy table keys the unified-exec family apart.
const TOOL_KEYS = Object.fromEntries([...NATIVE_SHELL_TOOLS].map((tool) => [tool, tool === "exec_command" || tool === "unified_exec" ? "unified_exec" : "shell"]));
TOOL_KEYS.apply_patch = "apply_patch";

function publishedMoveContent(file, cwd) {
  // Hosts can report logical cwd aliases (/tmp on macOS); compare against the
  // runtime's real ROOT using the same canonical cwd boundary.
  const destination = path.resolve(fs.realpathSync(cwd || ROOT), file);
  const relative = path.relative(ROOT, destination);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("patch move destination is outside the delivered repository");
  let current = ROOT;
  let metadata;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error("patch move destination contains a symlink");
  }
  if (!metadata?.isFile() || metadata.size > 4 * 1024 * 1024) throw new Error("patch move destination is not a bounded ordinary file");
  const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) throw new Error("patch move destination is not a bounded ordinary file");
    const limit = 4 * 1024 * 1024;
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > limit) throw new Error("patch move destination exceeds the bounded read limit");
    return buffer.subarray(0, offset).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function projectPayloads(payload) {
  payload = normalizeNativeInput(payload);
  if (payload.tool_name === "apply_patch") {
    if (typeof payload.tool_input?.command !== "string") throw new Error("apply_patch hook input requires command text");
    const inputs = guard.synthesizePolicyInputs("apply_patch", payload.tool_input);
    if (!inputs[0]?.file_path) throw new Error("apply_patch has no verifiable edit targets");
    if (inputs.length > guard.MAX_GATE_TARGETS) throw new Error("apply_patch exceeds the policy target limit");
    const sections = new Map();
    const moves = new Set();
    let section;
    for (const line of payload.tool_input.command.split(/\r?\n/)) {
      const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
      if (header) {
        section = { kind: header[1], old: [], next: [] };
        sections.set(header[2].trim(), section);
      } else if (section && line.startsWith("*** Move to: ")) {
        const destination = line.slice("*** Move to: ".length).trim();
        sections.set(destination, section); moves.add(destination);
      } else if (section && line.startsWith("+") ) section.next.push(line.slice(1));
      else if (section && line.startsWith("-")) section.old.push(line.slice(1));
    }
    return inputs.map((input) => {
      const body = sections.get(input.file_path);
      const write = body?.kind === "Add" || moves.has(input.file_path);
      const tool_input = { ...input };
      if (write) tool_input.content = moves.has(input.file_path) && payload.hook_event_name === "PostToolUse"
        ? publishedMoveContent(input.file_path, payload.cwd) : (body?.next || []).join("\n");
      else if (body) { tool_input.old_string = body.old.join("\n"); tool_input.new_string = body.next.join("\n"); }
      return { ...payload, tool_name: write ? "Write" : "Edit", tool_input };
    });
  }
  const name = TOOL_KEYS[payload.tool_name] ? "Bash" : NATIVE_AGENT_TOOLS.has(payload.tool_name) ? "Agent" : payload.tool_name;
  return [{ ...payload, tool_name: name }];
}

// Preserve the shared matcher's list/regex dialect, but never evaluate a regex
// on the native adapter thread. A child may hang; its wall-clock cap cannot.
const MATCHER_BUDGET_MS = 1000;
const MATCHER_CHILD = `const fs = require("node:fs");
const { matcherMatches } = require(process.argv[1]);
const [matcher, name, event] = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(matcherMatches(matcher, name, event)));`;
function boundedMatcher(deadline) {
  const cache = new Map();
  let remainingMatcherMs = MATCHER_BUDGET_MS;
  return (matcher, name, event) => {
    const key = JSON.stringify([matcher, name, event]);
    if (cache.has(key)) return cache.get(key);
    if (Date.now() >= deadline) throw new Error("Native policy evaluation exceeded its time budget.");
    let matched = typeof matcher !== "string" || matcher.length <= 4096
      ? matcherMatchesWithoutRegex(matcher, name, event) : null;
    if (matched === null) {
      const started = Date.now();
      const timeout = Math.min(remainingMatcherMs, deadline - started);
      if (timeout <= 0) throw new Error("Native policy matcher exceeded its time budget.");
      const result = spawnSync(process.execPath, ["-e", MATCHER_CHILD, require.resolve("./hook-engine")], {
        input: JSON.stringify([matcher, name, event]), encoding: "utf8", timeout,
        killSignal: "SIGKILL", maxBuffer: 1024,
      });
      remainingMatcherMs -= Date.now() - started;
      if (result.error || result.status !== 0 || !["true", "false"].includes(result.stdout)) {
        throw new Error("Native policy matcher could not complete within its bounded budget.");
      }
      matched = result.stdout === "true";
    }
    cache.set(key, matched);
    return matched;
  };
}

// Expansion preserves group order. Remove the Loom multiset from the combined
// view so local additions use the same registry validation/eligibility rules.
function localGroups(loomGroups) {
  const counts = new Map();
  for (const group of loomGroups) { const key = JSON.stringify(group); counts.set(key, (counts.get(key) || 0) + 1); }
  return (readExpandedSettings(ROOT).hooks?.PreToolUse || []).filter(group => {
    const key = JSON.stringify(group); const count = counts.get(key) || 0;
    if (!count) return true;
    counts.set(key, count - 1); return false;
  });
}

/** `deadline` is ABSOLUTE (ms since epoch) and belongs to the WHOLE call —
 * dispatch computes it once and shares it across every rendering and every
 * rewrite re-evaluation, so a call that fans out cannot outlive its budget and
 * be killed by the host's own hook timeout (what the host does then is
 * UNMEASURED, which is why the refuse-from-inside design exists). Direct
 * callers that omit it keep the previous per-call behaviour, sized below the
 * same 600-second configured hook deadline. */
function evaluateNative(payload, deadline = Date.now() + 550000) {
  if (payload.hook_event_name !== "PreToolUse") throw new Error("native policy adapter requires PreToolUse");
  if (typeof payload.tool_name !== "string" || !payload.tool_name) throw new Error("native tool name missing");
  const settings = readExpandedSettings(ROOT, { includeLocal: false });
  const projectedPayloads = projectPayloads(payload);
  const loomGroups = settings.hooks?.PreToolUse || [];
  const outcomes = [];
  const ran = new Set();
  try {
    // A Loom refusal returns before repo-local registries or regexes are read.
    for (const local of [false, true]) {
      const groups = local ? localGroups(loomGroups) : loomGroups;
      const matcherMatches = boundedMatcher(deadline);
      const selected = new Map();
      const add = (file, matcher, timeoutMs) => {
        const key = `${file}:${timeoutMs}`;
        if (!selected.has(key)) selected.set(key, { file, matchers: [], timeoutMs });
        selected.get(key).matchers.push(matcher);
      };
      const matches = (matcher, projected) => matcherMatches(matcher, projected.tool_name, payload.hook_event_name) || matcherMatches(matcher, payload.tool_name, payload.hook_event_name);
      const registeredFiles = new Set();
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          const file = hookBasename(hook.command);
          if (file) registeredFiles.add(file);
          if (!projectedPayloads.some((p) => matches(group.matcher, p))) continue;
          if (hook.type !== "command" || !file) throw new Error("selected policy descriptor is unsupported; register it explicitly in native hooks.json");
          const timeout = hook.timeout === undefined ? guard.SUBPROCESS_TIMEOUT_MS : hook.timeout * 1000;
          if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) throw new Error(`policy ${file} has an invalid timeout`);
          add(file, group.matcher, timeout);
        }
      }
      const policyKey = TOOL_KEYS[payload.tool_name];
      if (policyKey && !local) {
        if (!guard.POLICIES_POPULATED) throw new Error("delivered policy table is absent or unpopulated");
        for (const policy of guard.POLICIES[policyKey] || []) {
          // The live registration carries the precise matcher and timeout. Only
          // generated-only entries need their extraction-time matcher metadata.
          if (registeredFiles.has(policy.source_file)) continue;
          if (!Array.isArray(policy.cc_matchers) || !policy.cc_matchers.length) throw new Error("generated policy is missing matcher metadata");
          for (const matcher of policy.cc_matchers) add(policy.source_file, matcher, guard.SUBPROCESS_TIMEOUT_MS);
        }
      }
      // Intent capture must still happen when a sibling policy refuses the call.
      const ordered = [...selected.values()].sort((a, b) => Number(b.file === guard.CAPTURE_HOOK) - Number(a.file === guard.CAPTURE_HOOK));
      for (const { file: hookFile, matchers, timeoutMs } of ordered) {
        for (const [index, projected] of projectedPayloads.entries()) {
          const invocation = `${hookFile}:${index}`;
          if (local && ran.has(invocation)) continue; // Local rows cannot rerun/shadow Loom.
          if (!matchers.some((matcher) => matches(matcher, projected))) continue;
          ran.add(invocation);
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) return refusal("Native policy evaluation exceeded its time budget.");
          const result = guard.invokeHook({ hookFile, payload: projected, timeoutMs: Math.min(timeoutMs, remainingMs) });
          if (["missing", "error", "timeout", "crash"].includes(result.verdict)) {
            if (hookFile === guard.CAPTURE_HOOK) {
              outcomes.push({ hook: hookFile, stdout: JSON.stringify({ systemMessage: `Intent capture could not run (${result.verdict}); policy checks continue.` }), stderr: "", exitCode: 0 });
              continue;
            }
            return refusal(`Policy ${hookFile} could not run (${result.verdict}).`);
          }
          // Normalize every stdout record AND retain invokeHook's independently
          // computed verdict; a multiline deny must never degrade to plain context.
          const out = normalizeOutput("PreToolUse", result, payload.tool_name);
          const h = parseOutput(out.stdout)?.hookSpecificOutput;
          // A CC edit rewrite is a different schema from native V4A patch input.
          // Refuse instead of executing the original patch or inventing a rewrite.
          if (payload.tool_name === "apply_patch" && h?.updatedInput) {
            return refusal(`Policy ${hookFile} requested an edit rewrite that cannot be applied to a native patch.`);
          }
          outcomes.push({ hook: hookFile, ...out });
          if (out.exitCode === 2 || h?.permissionDecision === "deny") return mergeOutcomes("PreToolUse", outcomes);
        }
      }
    }
  } catch (error) {
    outcomes.push(refusal(error.message));
  }
  return mergeOutcomes("PreToolUse", outcomes);
}
module.exports = { projectPayloads, evaluateNative };
