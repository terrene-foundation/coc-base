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
const { MATCHER_BUDGET_MS, NATIVE_POLICY_BUDGET_MS, HookBudgetExceeded } = require("./hook-input-budget");
// DERIVED from the runtime's ONE shell-tool set (LOW c, security round):
// adding a tool there extends this table instead of leaving a second list to
// drift. The guard's policy table keys the unified-exec family apart.
const TOOL_KEYS = Object.fromEntries([...NATIVE_SHELL_TOOLS].map((tool) => [tool, tool === "exec_command" || tool === "unified_exec" ? "unified_exec" : "shell"]));
TOOL_KEYS.apply_patch = "apply_patch";

const PATCH_CONTENT_LIMIT = 4 * 1024 * 1024;
function patchError(code, message, remedy) {
  return Object.assign(new Error(code + ": " + message), { code, remedy });
}
function patchFilePath(file, cwd, allowMissing = false) {
  if (file.split(/[\\/]/).some(part => part === "." || part === "..")) throw patchError("PATCH_DOT_SEGMENT", "patch header contains a dot segment", "Use a target path without dot or dot-dot segments.");
  const base = fs.realpathSync.native(cwd || ROOT);
  const candidate = path.isAbsolute(file) ? file : base + path.sep + file;
  let probe = candidate, metadata, canonical;
  const missing = [];
  for (let count = 0; count < 128; count++) {
    try { metadata = fs.lstatSync(probe); }
    catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
      const part = path.basename(probe);
      if (!part || part === "." || part === "..") throw patchError("PATCH_TARGET_UNRESOLVED", "target cannot be resolved", "Use a resolvable ordinary target in the delivered checkout.");
      missing.unshift(part);
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
      continue;
    }
    if (missing.length === 0 && metadata.isSymbolicLink()) throw patchError("PATCH_TARGET_SYMLINK", "patch target is a symlink", "Use the ordinary destination itself; retain only directory aliases that resolve inside the delivered checkout.");
    canonical = fs.realpathSync.native(probe);
    if (missing.length) canonical = path.join(canonical, ...missing);
    break;
  }
  if (!canonical) throw patchError("PATCH_TARGET_UNRESOLVED", "target resolution exceeded its bound", "Use a shorter resolvable target path.");
  const top = require("./codex-rule-context").checkoutTop(ROOT, canonical), relative = top ? path.relative(fs.realpathSync.native(top), canonical) : "";
  if (!top || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw patchError("PATCH_TARGET_OUTSIDE", "patch target is outside the delivered repository", "Use the installed checkout or its declared assigned lane; do not route through an escaping alias.");
  if (missing.length) return canonical;
  if (!metadata?.isFile()) throw patchError("PATCH_TARGET_NOT_ORDINARY", "patch target is not a bounded ordinary file", "Use a regular file; FIFOs, directories and devices cannot supply bounded original bytes.");
  return canonical;
}

function publishedMoveContent(file, cwd) {
  const destination = patchFilePath(file, cwd);
  const metadata = fs.lstatSync(destination);
  if (!metadata?.isFile() || metadata.size > PATCH_CONTENT_LIMIT) throw patchError("PATCH_TARGET_TOO_LARGE", "patch target is not a bounded ordinary file", "Split the operation so each measured original and result is at most 4 MiB.");
  const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.size > PATCH_CONTENT_LIMIT) throw patchError("PATCH_TARGET_TOO_LARGE", "patch target is not a bounded ordinary file", "Split the operation so each measured original and result is at most 4 MiB.");
    const limit = PATCH_CONTENT_LIMIT;
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > limit) throw patchError("PATCH_TARGET_TOO_LARGE", "patch target exceeds the bounded read limit", "Split the operation into targets within the 4 MiB bound.");
    return buffer.subarray(0, offset).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function projectionProblem(error, span, operation) {
  const codes = { "patch-context-mismatch": "PATCH_CONTEXT_MISMATCH", "patch-alias-uncertain": "PATCH_ALIAS_CONFLICT", "patch-envelope-invalid": "PATCH_ENVELOPE_INVALID", "patch-grammar-unsupported": "PATCH_GRAMMAR_UNSUPPORTED", ENOENT: "PATCH_TARGET_MISSING", ELOOP: "PATCH_TARGET_SYMLINK" };
  const code = operation === "Delete" ? "PATCH_DELETE_UNDETERMINED" : codes[error.code] || (String(error.code).startsWith("PATCH_") ? error.code : "PATCH_TARGET_READ_FAILED");
  const remedies = { PATCH_CONTEXT_MISMATCH: "Read the current original and regenerate ordered context from those bytes.", PATCH_ALIAS_CONFLICT: "Combine all edits to one canonical file in a single Update section.", PATCH_ENVELOPE_INVALID: "Supply the required Begin Patch and End Patch envelope.", PATCH_GRAMMAR_UNSUPPORTED: "Use supported file directives and prefixed context/removal/addition lines.", PATCH_TARGET_MISSING: "Read an existing original, or use Add File when creating a new file.", PATCH_DELETE_UNDETERMINED: "Delete requires measurable complete original bytes; resolve the reported target/read failure before retrying.", PATCH_TARGET_READ_FAILED: "Resolve the target read failure and regenerate the patch from the actual original." };
  return { code, span, reason: "after-bytes cannot be derived: " + error.message, remedy: error.remedy || remedies[code] || "Correct the reported target or patch condition before retrying." };
}

// Whole-file projection: projectPayloads checks one complete original→after
// replacement per Pre Update/Delete, and complete after-bytes at Move destinations.
// Derivation uses the shared admitted cursor applier; its placement is in
// .claude/hooks/lib/codex-foundation-adapter.js:440-467 (applyHunks).
// This caller refuses unmeasured anchors, EOF constraints, pure additions,
// empty hunks and reads it cannot establish. The marker scan owns the EOF
// refusal; parsePatch checks the remaining grammar. Sources: .claude/hooks/lib/codex-native-policy.js:178-274.
const PATCH_ENVELOPE = new Set(["*** Begin Patch", "*** End Patch"]);
const PATCH_EOF_MARKER = "*** End of File";
// The admitted grammar's own anchor shape (`codex-foundation-adapter.js`
// HUNK_ANCHOR, the SSOT for this grammar): a bare `@@` opens a hunk, and
// `@@ <text>` names the enclosing context the hunk lives in.
const HUNK_ANCHOR = /^@@(?: (.*))?$/;
const PATCH_UNREPRESENTABLE = Object.freeze({
  anchor: "the hunk anchor is a locator, not removed text: which section the hunk applies to cannot be carried by an old→new pair",
  eofMarker: "the `*** End of File` marker constrains the hunk to the end of the file; the edit projection has no at-end-of-file field",
  unpresentable: "a body line with no \" \"/\"-\"/\"+\" prefix carries neither a context requirement nor a removed/added line the edit projection can represent",
  deleteBody: "a Delete File section carries no body line, so this element has no place in the projection",
});

/** Scan a patch body into per-section hunks, declaring every element the edit
 *  projection cannot represent. Each section is
 *  `{kind, content: [], hunks: [{anchor, old, next}], unresolved: [{span, reason}]}`
 *  and `loose` holds unmodelled lines outside any section (they belong to no
 *  target, so they are declared on every projection rather than dropped). */
function scanPatchSections(command) {
  const sections = new Map();
  const moves = new Set();
  const loose = [];
  let section = null;
  for (const line of command.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      section = { kind: header[1], source: header[2].trim(), moveTo: null, content: [], hunks: [], unresolved: [] };
      sections.set(header[2].trim(), section);
      continue;
    }
    if (line === "*** End Patch") { section = null; continue; }
    if (PATCH_ENVELOPE.has(line)) continue;
    if (!section) {
      // A body line before any file section, or after the envelope's close,
      // belongs to no target — declared, never dropped.
      if (line.trim()) loose.push({ span: line, reason: PATCH_UNREPRESENTABLE.unpresentable });
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      const destination = line.slice("*** Move to: ".length).trim();
      section.moveTo = destination;
      sections.set(destination, section); moves.add(destination);
      continue;
    }
    if (section.kind === "Add") {
      if (line.startsWith("+")) section.content.push(line.slice(1));
      else if (line === PATCH_EOF_MARKER || HUNK_ANCHOR.test(line)) continue; // no locator meaning: the path IS the location
      else if (line.trim()) section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.unpresentable });
      continue;
    }
    if (section.kind === "Delete") {
      if (line.trim()) section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.deleteBody });
      continue;
    }
    const anchor = line.match(HUNK_ANCHOR);
    if (anchor) {
      // An EMPTY anchor text (`@@` or `@@ `) locates nothing, so it is not a
      // drop — the same reading that makes a bare `@@` a separator. Only
      // NON-EMPTY text is a locator this projection cannot carry.
      const text = anchor[1] === undefined || anchor[1].trim() === "" ? null : anchor[1];
      if (text !== null) section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.anchor });
      section.hunks.push({ anchor: text, old: [], next: [] });
      continue;
    }
    if (line === PATCH_EOF_MARKER) {
      section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.eofMarker });
      continue;
    }
    if (line === "") {
      let hunk = section.hunks[section.hunks.length - 1];
      if (!hunk) section.hunks.push((hunk = { anchor: null, old: [], next: [] }));
      hunk.old.push(""); hunk.next.push("");
      continue;
    }
    if (!(line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) {
      if (line.trim()) section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.unpresentable });
      continue;
    }
    let hunk = section.hunks[section.hunks.length - 1];
    if (!hunk) section.hunks.push((hunk = { anchor: null, old: [], next: [] }));
    // A context line belongs to BOTH sides — the admitted derivation's reading.
    if (line.startsWith(" ") || line.startsWith("-")) hunk.old.push(line.slice(1));
    if (line.startsWith(" ") || line.startsWith("+")) hunk.next.push(line.slice(1));
  }
  return { sections, moves, loose };
}

function projectPayloads(payload) {
  payload = normalizeNativeInput(payload);
  payload = require("./codex-tool-contracts").projectStructuredTool(payload);
  if (payload.tool_name === "apply_patch") {
    if (typeof payload.tool_input?.command !== "string") throw new Error("apply_patch hook input requires command text");
    const inputs = guard.synthesizePolicyInputs("apply_patch", payload.tool_input);
    if (!inputs[0]?.file_path) throw new Error("apply_patch has no verifiable edit targets");
    if (inputs.length > guard.MAX_GATE_TARGETS) throw new Error("apply_patch exceeds the policy target limit");
    const { sections, moves, loose } = scanPatchSections(payload.tool_input.command);
    const foundation = require("./codex-foundation-adapter");
    const canonicalPaths = new Map();
    try {
      let grammar = payload.tool_input.command.split(/\r?\n/).filter(line => line !== PATCH_EOF_MARKER).join("\n");
      if (payload.hook_event_name === "PostToolUse" && !grammar.startsWith("*** Begin Patch\n"))
        grammar = "*** Begin Patch\n" + grammar + "\n*** End Patch";
      const parsed = foundation.parsePatch(grammar);
      const hunkCount = parsed.operations.reduce((n, op) => n + op.hunks.length, 0);
      if (hunkCount > 256) loose.push({ code: "PATCH_HUNK_LIMIT", span: "<patch>", reason: "patch exceeds the 256-hunk projection limit", remedy: "Split the patch into calls of at most 256 hunks each." });
      const claimedPaths = new Set(), claimedFiles = new Set();
      for (const file of parsed.operations.flatMap(op => op.moveTo === null ? [op.path] : [op.path, op.moveTo])) {
        const canonical = patchFilePath(file, payload.cwd, true);
        canonicalPaths.set(file, canonical);
        let identity = null;
        try {
          const metadata = fs.lstatSync(canonical);
          identity = String(metadata.dev) + ":" + String(metadata.ino);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (claimedPaths.has(canonical) || (identity !== null && claimedFiles.has(identity)))
          throw patchError("PATCH_ALIAS_CONFLICT", "multiple patch targets alias one file; the combined after-bytes are undetermined", "Combine the edits in one canonical Update section.");
        claimedPaths.add(canonical);
        if (identity !== null) claimedFiles.add(identity);
      }
    } catch (error) {
      if (payload.hook_event_name === "PostToolUse") throw error;
      if (![...sections.values()].some(section => section.unresolved.length))
        loose.push(projectionProblem(error, "<patch>"));
    }
    const afterBySection = new Map();
    return inputs.map((input) => {
      const body = sections.get(input.file_path);
      const published = payload.hook_event_name === "PostToolUse";
      const write = body?.kind === "Add" || moves.has(input.file_path);
      const unresolved = [...(body?.unresolved || []), ...loose];
      const tool_input = { ...input };
      if (unresolved.length === 0) tool_input.file_path = canonicalPaths.get(input.file_path) || patchFilePath(input.file_path, payload.cwd, true);
      if ((body?.kind === "Update" || body?.kind === "Delete") && unresolved.length === 0) {
        for (const hunk of body.hunks) {
          if (hunk.old.length === 0 && hunk.next.length > 0)
            unresolved.push({ code: "PATCH_PURE_ADDITION", span: "@@ hunk " + (body.hunks.indexOf(hunk) + 1), reason: "a pure-addition hunk has no measured placement", remedy: "Include existing context that identifies the insertion point." });
          if (hunk.old.length === 0 && hunk.next.length === 0)
            unresolved.push({ code: "PATCH_HUNK_EMPTY", span: "@@ hunk " + (body.hunks.indexOf(hunk) + 1), reason: "an empty hunk has no admitted replacement", remedy: "Remove the empty separator or supply its actual replacement lines." });
        }
        if (unresolved.length === 0) {
          try {
            if (body.kind === "Delete" && published) afterBySection.set(body, { before: "", after: "" });
            if (!afterBySection.has(body)) {
              if (body.moveTo) patchFilePath(body.moveTo, payload.cwd, !published);
              const current = publishedMoveContent(canonicalPaths.get(published && body.moveTo ? body.moveTo : body.source), payload.cwd);
              const after = body.kind === "Delete" ? "" : published ? current : foundation.applyHunks({ raw: body.source },
                body.hunks.map(h => ({ oldLines: h.old, newLines: h.next })), current);
              if (Buffer.byteLength(after, "utf8") > PATCH_CONTENT_LIMIT) throw patchError("PATCH_TARGET_TOO_LARGE", "derived target exceeds the bounded read limit", "Split the change so the complete after-bytes fit within 4 MiB.");
              if (!published && current.length === 0) throw patchError(body.kind === "Delete" ? "PATCH_DELETE_UNDETERMINED" : "PATCH_EMPTY_ORIGINAL", "an empty original cannot carry a whole-file Edit comparison", "Use an operation whose original state can be measured and represented; do not submit an empty comparison.");
              afterBySection.set(body, { before: current, after });
            }
            const result = afterBySection.get(body);
            if (write) tool_input.content = result.after;
            else {
              tool_input.old_string = published ? "" : result.before;
              tool_input.new_string = body.moveTo || body.kind === "Delete" ? "" : result.after;
            }
          } catch (error) {
            if (published) throw error;
            unresolved.push(projectionProblem(error, input.file_path, body.kind));
          }
        }
      }
      if (unresolved.length) {
        for (const issue of unresolved) {
          if (issue.code) continue;
          const kind = Object.keys(PATCH_UNREPRESENTABLE).find(key => PATCH_UNREPRESENTABLE[key] === issue.reason);
          issue.code = { anchor: "PATCH_ANCHOR_UNMEASURED", eofMarker: "PATCH_EOF_UNMEASURED", unpresentable: "PATCH_LINE_UNSUPPORTED", deleteBody: "PATCH_DELETE_BODY" }[kind] || "PATCH_DERIVATION_UNDETERMINED";
          issue.remedy = { anchor: "Replace the locator with literal existing context lines.", eofMarker: "Use an operation whose end-of-file constraint can be measured before execution.", unpresentable: "Prefix context, removal and addition lines with space, minus and plus respectively.", deleteBody: "Remove body lines from the Delete File section." }[kind] || "Correct the reported patch condition before retrying.";
        }
        return { ...payload, tool_name: write ? "Write" : "Edit", tool_input, projection: Object.freeze({
          verdict: "undetermined",
          reason: `missing fact: the edit projection for "${input.file_path}" cannot represent ${unresolved.length} patch element(s)`,
          unresolved,
        }) };
      }
      if (body?.kind === "Add") tool_input.content = body.content.join("\n");
      return { ...payload, tool_name: write ? "Write" : "Edit", tool_input };
    });
  }
  const name = TOOL_KEYS[payload.tool_name] ? "Bash" : NATIVE_AGENT_TOOLS.has(payload.tool_name) ? "Agent" : payload.tool_name;
  return [{ ...payload, tool_name: name, ...(payload.launch_diagnostics
    ? { launch_diagnostics: { ...payload.launch_diagnostics, projected_tool_name: name } } : {}) }];
}

// Preserve the shared matcher's list/regex dialect, but never evaluate a regex
// on the native adapter thread. A child may hang; its wall-clock cap cannot.
const MATCHER_CHILD = `const fs = require("node:fs");
const { matcherMatches } = require(process.argv[1]);
const [matcher, name, event] = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(matcherMatches(matcher, name, event)));`;
function boundedMatcher(deadline, budgetMs = NATIVE_POLICY_BUDGET_MS) {
  const cache = new Map();
  let remainingMatcherMs = MATCHER_BUDGET_MS;
  return (matcher, name, event) => {
    const key = JSON.stringify([matcher, name, event]);
    if (cache.has(key)) return cache.get(key);
    if (Date.now() >= deadline) throw new HookBudgetExceeded("Native policy evaluation", budgetMs, "time budget expired");
    let matched = typeof matcher !== "string" || matcher.length <= 4096
      ? matcherMatchesWithoutRegex(matcher, name, event) : null;
    if (matched === null) {
      const started = Date.now();
      const timeout = Math.min(remainingMatcherMs, deadline - started);
      if (timeout <= 0) throw new HookBudgetExceeded("Native policy matcher", MATCHER_BUDGET_MS, "matcher budget expired");
      const result = spawnSync(process.execPath, ["-e", MATCHER_CHILD, require.resolve("./hook-engine")], {
        input: JSON.stringify([matcher, name, event]), encoding: "utf8", timeout,
        killSignal: "SIGKILL", maxBuffer: 1024,
      });
      remainingMatcherMs -= Date.now() - started;
      if (result.error?.code === "ETIMEDOUT") throw new HookBudgetExceeded("Native policy matcher", timeout, "bounded budget expired");
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
function evaluateNative(payload, deadline = Date.now() + NATIVE_POLICY_BUDGET_MS, budgetMs = NATIVE_POLICY_BUDGET_MS) {
  if (payload.hook_event_name !== "PreToolUse") throw new Error("native policy adapter requires PreToolUse");
  if (typeof payload.tool_name !== "string" || !payload.tool_name) throw new Error("native tool name missing");
  const settings = readExpandedSettings(ROOT, { includeLocal: false });
  const projectedPayloads = projectPayloads(payload);
  const loomGroups = settings.hooks?.PreToolUse || [];
  const outcomes = [];
  const ran = new Set();
  // An UNDETERMINED projection refuses the call. The patch is ONE atomic tool
  // call, so a section whose elements the edit projection could not represent
  // makes the WHOLE call undecidable: allowing the representable half would
  // wave through the half nobody could read. The refusal is PUSHED into
  // `outcomes` rather than returned here so the rest of the chain still runs —
  // intent capture must record what was attempted even when a sibling refuses
  // (journal/0216), and any path gate's own verdict still travels beside it.
  const undetermined = projectedPayloads.filter((p) => p.projection?.verdict === "undetermined");
  if (undetermined.length) {
    const detail = undetermined
      .flatMap((p) => p.projection.unresolved.map((u) => `[${u.code}] ${u.span.trim().slice(0, 120)} — ${u.reason}. Remedy: ${u.remedy}`))
      .slice(0, 4).join("; ");
    outcomes.push(refusal(`apply_patch cannot be evaluated: ${undetermined.length} of ${projectedPayloads.length} projected target(s) carry undetermined patch facts (${detail}). Correct the named condition before retrying.`));
  }
  try {
    const context = require("./codex-rule-context").collectRuleContext(ROOT, payload, projectedPayloads);
    if (context) outcomes.push({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } }), stderr: "", exitCode: 0 });
    // A Loom refusal returns before repo-local registries or regexes are read.
    for (const local of [false, true]) {
      const groups = local ? localGroups(loomGroups) : loomGroups;
      const matcherMatches = boundedMatcher(deadline, budgetMs);
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
          if (remainingMs <= 0) return refusal(new HookBudgetExceeded("Native policy evaluation", budgetMs, "time budget expired"));
          const capability = guard.policyCapability(hookFile, groups);
          const facts = guard.invokeHook({ hookFile, payload: projected, timeoutMs: Math.min(timeoutMs, remainingMs) });
          const result = guard.classifyPolicyOutcome(facts, { canDeny: capability.can_deny });
          if (result.verdict === "timeout" && hookFile !== guard.CAPTURE_HOOK) return refusal(new HookBudgetExceeded(`Policy ${hookFile}`, Math.min(timeoutMs, remainingMs), "policy handler timeout"));
          if (["missing", "error", "timeout", "crash"].includes(result.verdict)) {
            if (hookFile === guard.CAPTURE_HOOK) {
              outcomes.push({ hook: hookFile, stdout: JSON.stringify({ systemMessage: `Intent capture could not run (${result.verdict}); policy checks continue.` }), stderr: "", exitCode: 0 });
              continue;
            }
            return refusal(`Policy ${hookFile} could not run (${result.verdict}).`);
          }
          if (["warn-denied", "ask-denied"].includes(result.verdict)) {
            const restrictive = normalizeOutput("PreToolUse", result, payload.tool_name);
            if (restrictive.exitCode === 2) return restrictive;
            return refusal(`Policy ${hookFile} could not authorize the call (${result.verdict}).`);
          }
          // Native normalization remains stricter than the MCP advisory transport
          // (.claude/hooks/lib/codex-hook-runtime.js:349-400).
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
    outcomes.push(refusal(error instanceof Error ? error : new Error("Codex hook raised a non-Error throwable.")));
  }
  return mergeOutcomes("PreToolUse", outcomes);
}
// `scanPatchSections` is exported for the projection-completeness suite: a
// mutation proof needs its reach token derived from the LOADED function's own
// source, and an unexported function has no source a subject process can read
// (the same reason `restoreNativeRewrite` is exported for the cases-codex
// corpus). No production caller reads it.
module.exports = { projectPayloads, evaluateNative, boundedMatcher, scanPatchSections };
