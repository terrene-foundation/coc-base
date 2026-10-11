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
  // Hosts can report logical cwd aliases (/tmp on macOS); canonicalize (native: on-disk case)
  // with the resolver checkoutTop uses for ROOT, so both sides of the boundary agree.
  const destination = path.resolve(fs.realpathSync.native(cwd || ROOT), file);
  const top = require("./codex-rule-context").checkoutTop(ROOT, destination), relative = top ? path.relative(top, destination) : "";
  if (!top || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("patch move destination is outside the delivered repository");
  let current = top;
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

// ---------------------------------------------------------------------------
// Patch projection — COMPLETENESS (every grammar element REPRESENTED or DECLARED)
// ---------------------------------------------------------------------------
// The projection below TRANSLATES a native V4A patch into the Edit/Write
// vocabulary the delivered CC hooks read, and it is sound only while every
// element of the patch is either REPRESENTED or DECLARED. An element the scan
// drops silently makes structurally DIFFERENT patches project IDENTICALLY, and
// a consumer then reasons about an operation that is not the one on the wire.
// MEASURED (2026-10-08, controls firing both directions): the baseline
// `@@ / -OLD / +NEW` AND all of (a) an added `@@ missing-anchor` plus a
// ` EXPECTED-CONTEXT` line, (b) an added `*** End of File`, (c) `@@ FIRST` vs
// `@@ SECOND`, collapsed to the same {file_path, old_string:"OLD", new_string:
// "NEW"} and the same target-only {file_path} — the earlier scan read headers,
// `+` and `-` only, so context, anchors and markers never reached a consumer.
//
// The repair is the L1 contract's own rule (`guard-foundation/contract.js`: a
// missing fact is UNDETERMINED — never false, never an empty result):
//   - REPRESENTED — a context line IS part of the matched block, so it is
//     carried into BOTH sides, the same reading the admitted derivation
//     implements (`codex-foundation-adapter.js::applyHunks`: " "/"-" build the
//     old block, " "/"+" the new one). Dropping it makes the projection require
//     strictly LESS than the patch does.
//   - DECLARED — an element the CC Edit shape cannot express marks the
//     projection undetermined, and `evaluateNative` refuses the call. A hunk
//     ANCHOR is a locator and NOT removed text, so folding it into old_string
//     would claim the patch deletes a line it does not; a `*** End of File`
//     constrains WHERE the hunk lands; a SECOND hunk is a second, disjoint
//     replacement that one contiguous old→new pair cannot express; an
//     unprefixed body line is content the shape cannot place.
//     THE ANCHOR IS NOT MERELY UNMEASURED — it is MEASURED to select the
//     occurrence: on 'FIRST\nOLD\nSECOND\nOLD\nTAIL\n' the applier lands
//     `@@ FIRST` on 'FIRST\nNEW\nSECOND\nOLD\nTAIL\n' and `@@ SECOND` on
//     'FIRST\nOLD\nSECOND\nNEW\nTAIL\n' from an IDENTICAL old→new pair
//     (security seat, 2026-10-08; sha256 7a024809… / 4d49f1c1…). Both arms are
//     therefore marked, including `@@ FIRST` even though its bytes coincide
//     with the anchor-free arm's: asserting THAT coincidence would require a
//     locating rule this projection does not implement and cannot check.
//   - NOT a drop, so not a mark: a bare `@@` separator and an EMPTY anchor text
//     (`@@` / `@@ `) select nothing, and in an Add section the path IS the
//     location, so `@@`/`*** End of File` there carry no locator meaning.
//     Grammar VALIDITY is a different question this projection has never
//     answered (it tolerates a missing envelope by design — see
//     codex-foundation-adapter.js's header on that boundary).
//   - The mark travels in the shape the consumers already speak
//     ({verdict, reason, unresolved}), so a non-blocking consumer can read it
//     and the blocking one acts on it. A determined projection carries no mark,
//     which is exact rather than assumed: the scan below represents or declares
//     EVERY line, so its silence is a closed claim.
const PATCH_ENVELOPE = new Set(["*** Begin Patch", "*** End Patch"]);
const PATCH_EOF_MARKER = "*** End of File";
// The admitted grammar's own anchor shape (`codex-foundation-adapter.js`
// HUNK_ANCHOR, the SSOT for this grammar): a bare `@@` opens a hunk, and
// `@@ <text>` names the enclosing context the hunk lives in.
const HUNK_ANCHOR = /^@@(?: (.*))?$/;
const PATCH_UNREPRESENTABLE = Object.freeze({
  anchor: "the hunk anchor is a locator, not removed text: which section the hunk applies to cannot be carried by an old→new pair",
  multiHunk: "a second hunk in one section is a second, disjoint replacement; concatenating them into one old→new pair would fabricate a contiguity the patch does not have",
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
      section = { kind: header[1], content: [], hunks: [], unresolved: [] };
      sections.set(header[2].trim(), section);
      continue;
    }
    if (PATCH_ENVELOPE.has(line)) continue;
    if (!section) {
      // A body line before any file section, or after the envelope's close,
      // belongs to no target — declared, never dropped.
      if (line.trim()) loose.push({ span: line, reason: PATCH_UNREPRESENTABLE.unpresentable });
      continue;
    }
    if (line.startsWith("*** Move to: ")) {
      const destination = line.slice("*** Move to: ".length).trim();
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
      const open = section.hunks[section.hunks.length - 1];
      if (open && open.old.length === 0 && open.next.length === 0) open.anchor = text; // an empty hunk is not a hunk
      else {
        if (open) section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.multiHunk });
        section.hunks.push({ anchor: text, old: [], next: [] });
      }
      continue;
    }
    if (line === PATCH_EOF_MARKER) {
      section.unresolved.push({ span: line, reason: PATCH_UNREPRESENTABLE.eofMarker });
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
    return inputs.map((input) => {
      const body = sections.get(input.file_path);
      const write = body?.kind === "Add" || moves.has(input.file_path);
      const unresolved = [...(body?.unresolved || []), ...loose];
      const tool_input = { ...input };
      if (unresolved.length) {
        // The claim is WITHHELD, not weakened: no old_string/new_string/content
        // is emitted for a section whose patch elements could not be
        // represented, so no consumer can read a partial pair as the edit.
        return { ...payload, tool_name: write ? "Write" : "Edit", tool_input, projection: Object.freeze({
          verdict: "undetermined",
          reason: `missing fact: the edit projection for "${input.file_path}" cannot represent ${unresolved.length} patch element(s)`,
          unresolved,
        }) };
      }
      // An Add section's content is its `+` lines; a `Move to` destination
      // projects the source section's added lines (the moved file's body).
      const added = body ? (body.kind === "Add" ? body.content : body.hunks.flatMap((h) => h.next)) : [];
      if (write) tool_input.content = moves.has(input.file_path) && payload.hook_event_name === "PostToolUse"
        ? publishedMoveContent(input.file_path, payload.cwd) : added.join("\n");
      else if (body) {
        tool_input.old_string = body.hunks.flatMap((h) => h.old).join("\n");
        tool_input.new_string = body.hunks.flatMap((h) => h.next).join("\n");
      }
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
      .flatMap((p) => p.projection.unresolved.map((u) => `${u.span.trim().slice(0, 120)} — ${u.reason}`))
      .slice(0, 4).join("; ");
    outcomes.push(refusal(`apply_patch cannot be evaluated: ${undetermined.length} of ${projectedPayloads.length} projected target(s) carry patch elements the edit projection cannot represent (${detail}). Re-issue the patch without the unrepresentable element — a hunk anchor, a \`*** End of File\` marker and an unprefixed body line are each avoidable, and one file section carries ONE hunk — then retry.`));
  }
  try {
    const context = require("./codex-rule-context").collectRuleContext(ROOT, payload, projectedPayloads);
    if (context) outcomes.push({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } }), stderr: "", exitCode: 0 });
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
          const capability = guard.policyCapability(hookFile, groups);
          const facts = guard.invokeHook({ hookFile, payload: projected, timeoutMs: Math.min(timeoutMs, remainingMs) });
          const result = guard.classifyPolicyOutcome(facts, { canDeny: capability.can_deny });
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
          // (.claude/hooks/lib/codex-hook-runtime.js:340-364).
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
// `scanPatchSections` is exported for the projection-completeness suite: a
// mutation proof needs its reach token derived from the LOADED function's own
// source, and an unexported function has no source a subject process can read
// (the same reason `restoreNativeRewrite` is exported for the cases-codex
// corpus). No production caller reads it.
module.exports = { projectPayloads, evaluateNative, boundedMatcher, scanPatchSections };
