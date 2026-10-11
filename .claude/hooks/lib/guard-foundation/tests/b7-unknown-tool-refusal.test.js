/**
 * B7 — integrity-guard must REFUSE an UNKNOWN tool instead of allowing a tool
 * it does not recognize.
 *
 * THE PROBE, MEASURED before this change (this worktree, integrity-guard run
 * directly with a PreToolUse payload):
 *   Write on .claude/operators.roster.json -> status 2, deny      (the fence)
 *   Patch on the SAME path                 -> status 0, continue  <- SAILED THROUGH
 *
 * WHY PASSING IS WRONG (effects-incomplete semantics). The guard's job is to
 * bound a mutation's effect on integrity-critical paths. For an unclassified
 * tool it cannot do that at all: it does not know whether the tool mutates, or
 * which of the payload's fields names the target — so `watched: false` was not
 * the answer "not a mutation", it was the answer "not understood", emitted in
 * the grammar of a clean pass. An unknown tool is UNDETERMINED, and
 * undetermined is not clean.
 *
 * RED-CASE-FIRST: the RED CASE tests fail against the pre-change tree (Patch
 * passes); the controls pin today's known-tool behavior so the change cannot
 * silently alter it.
 *
 * AMENDMENT (compliance blocker, 2026-10-08, csq via the orchestrator): the
 * FIRST shipped rule refused ANY unknown tool. That breaks MCP integrations —
 * a csq session's mcp__csq-messaging__* calls write only csq's own message
 * store, never repo files. The rule is NARROWED to what it was protecting: an
 * unknown tool REFUSES only when its payload names a path that resolves into
 * this repository (it can mutate the repo); a path-less unknown tool (MCP
 * messaging, docs, search) proceeds with an ADVISORY plus a RECORDED UNKNOWN
 * effect. The hostile pole — unknown + repo path — must never go soft.
 *
 * Run: node --test .claude/hooks/lib/guard-foundation/tests/b7-unknown-tool-refusal.test.js
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const HOOK = path.join(REPO, ".claude", "hooks", "integrity-guard.js");
const BLOCKED = 2;
const WATCHED = ".claude/operators.roster.json";

function runGuard(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: REPO,
    encoding: "utf8",
    timeout: 30000,
  });
  let decision = null;
  let reason = "";
  try {
    const last = res.stdout.trim().split("\n").pop();
    const j = JSON.parse(last);
    if (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision) {
      decision = j.hookSpecificOutput.permissionDecision;
      reason = j.hookSpecificOutput.permissionDecisionReason || "";
    } else if (j.continue === true) {
      decision = "continue";
    }
  } catch {
    decision = "unparsed";
  }
  return { status: res.status, decision, reason, raw: res.stdout };
}

const base = { hook_event_name: "PreToolUse", cwd: REPO };

test("B7 AMENDED RED CASE: the refusal fires ONLY on the path-bearing hostile shape", () => {
  // (b) hostile pole — an unknown tool whose payload names a path INSIDE the
  // repo can mutate the repo: REFUSE. This pole must NEVER go soft (the
  // amendment narrows the rule; it must not neuter it).
  const protectedPath = runGuard({ ...base, tool_name: "Patch", tool_input: { file_path: WATCHED } });
  assert.equal(protectedPath.status, BLOCKED, "unknown tool aimed at a protected path must refuse");
  assert.equal(protectedPath.decision, "deny");
  assert.match(protectedPath.reason, /Patch/, "the reason must NAME the refused tool");
  assert.match(protectedPath.reason, /unknown/i, "the reason must say WHY: the tool is unknown to the inventory");

  const repoPath = runGuard({ ...base, tool_name: "Patch", tool_input: { file_path: "notes.txt" } });
  assert.equal(
    repoPath.status,
    BLOCKED,
    "a RELATIVE path resolves into this repository — an unknown tool aimed at the repo refuses on the same pole",
  );
});

test("B7 AMENDMENT PAIR: MCP/path-less unknown tools are NOT refused on unknown-ness alone (advisory + recorded UNKNOWN effect)", () => {
  const send = runGuard({
    ...base,
    tool_name: "mcp__csq-messaging__send",
    tool_input: { to: { name: "team-lead" }, body: "status ping" },
  });
  assert.equal(send.status, 0, "csq-messaging__send must be ALLOWED (writes only csq's own message store)");

  const inbox = runGuard({ ...base, tool_name: "mcp__csq-messaging__inbox", tool_input: {} });
  assert.equal(inbox.status, 0, "csq-messaging__inbox must be ALLOWED (read)");

  const pathless = runGuard({ ...base, tool_name: "Frobnicate", tool_input: { query: "summarize" } });
  assert.equal(pathless.status, 0, "a path-less unknown tool must NOT be refused on unknown-ness alone");
  assert.equal(pathless.decision, "continue", "it proceeds after the advisory");
  assert.match(pathless.raw, /UNKNOWN/i, "the advisory must RECORD the UNKNOWN effect on the surface");
});

test("B7 ARRAY-HOLE RED CASE: batch/array file shapes still reach the refusal (security verdict registry-security-2)", () => {
  // The HIGH inside the narrowing's floor: ARRAY values were never collected
  // (the recursion lost the key context and dropped string elements), so a
  // common MCP batch-file schema read as path-less — measured rc 0 + advisory
  // on every shape below while the payload named a repo path.
  const shapes = [
    { files: ["notes.txt"] }, // array under a path-shaped key
    { file: ["notes.txt"] }, // singular key, array value
    { paths: [path.join(REPO, ".claude", "operators.roster.json")] }, // ABSOLUTE path inside the repo
    { target: { files: ["notes.txt"] } }, // nested container -> array
  ];
  for (const toolInput of shapes) {
    const r = runGuard({ ...base, tool_name: "Patch", tool_input: toolInput });
    assert.equal(
      r.status,
      BLOCKED,
      `array/batch shape must REFUSE (it names a repo path): ${JSON.stringify(toolInput)}`,
    );
    assert.match(r.reason, /Patch/, "the refusal still names the tool");
  }
});

test("B7 OVER-REFUSAL CONTROLS: array shapes that name NO repo path stay ADVISORY", () => {
  // delta-(4) acceptance controls (the seat): an array of OUTSIDE paths stays
  // advisory, and so does a NON-path-key array — the entry-collection must not
  // turn every string into a candidate.
  const outsideAbs = runGuard({
    ...base,
    tool_name: "Patch",
    tool_input: { files: ["/tmp/gf-not-in-repo-probe"] },
  });
  assert.notEqual(outsideAbs.status, BLOCKED, "absolute OUTSIDE path in an array must stay advisory");

  const outsideRel = runGuard({
    ...base,
    tool_name: "Patch",
    tool_input: { files: ["../guarded-outside-probe"] },
  });
  assert.notEqual(outsideRel.status, BLOCKED, "relative path resolving OUTSIDE the repo must stay advisory");

  const nonPathKey = runGuard({
    ...base,
    tool_name: "Frobnicate",
    tool_input: { tags: ["build", "release"] },
  });
  assert.notEqual(
    nonPathKey.status,
    BLOCKED,
    "a NON-path-key array of relative words is not a batch-file schema — collecting it would over-refuse",
  );
});

test("B7 DELTA-(4) CONTROL SET: the seat's measured over-collection shapes all stay ADVISORY", () => {
  // registry-security-2's delta-(4) finding, 1:1: at b40813865 every one of
  // these read deny rc=2 (plain entry-collection over-refused). The
  // key-context threading must keep them all advisory.
  const advisoryShapes = [
    { queries: ["deploy steps"] },
    { tags: ["urgent"] },
    { ids: ["a", "b"] },
    { rows: [["a", "b"]] },
    { payload: { items: ["x"] } },
    { meta: { labels: ["hi"] } },
    { queries: ["https://docs.example/x"] },
  ];
  for (const toolInput of advisoryShapes) {
    const r = runGuard({ ...base, tool_name: "Frobnicate", tool_input: toolInput });
    assert.notEqual(
      r.status,
      BLOCKED,
      `must stay ADVISORY (no path-key context): ${JSON.stringify(toolInput)}`,
    );
  }
});

test("B7 PADDING-BYPASS RED CASE: a real repo path must not ride past the candidate cap", () => {
  // delta-(4) sub-finding, re-measured: 16 matched /tmp candidates exhaust the
  // recursion gate, then a nested {path:"notes.txt"} — the real in-repo path —
  // is never inspected (rc 0 + row). This is the SAME padding bypass the
  // per-push-cap rejection condemned; the gate carries its own evasion class.
  const padder = {
    files: Array.from({ length: 16 }, (_, i) => `/tmp/gf-pad-${i}`),
    deep: { path: "notes.txt" },
  };
  const r = runGuard({ ...base, tool_name: "Patch", tool_input: padder });
  assert.equal(
    r.status,
    BLOCKED,
    "the in-repo path must still be collected when 16 out-of-repo candidates precede it",
  );
});

test("B7 CONTROL: known tools behave EXACTLY as before", () => {
  const write = runGuard({ ...base, tool_name: "Write", tool_input: { file_path: WATCHED, content: "x" } });
  assert.equal(write.status, BLOCKED, "Write on a watched path still denies");
  assert.equal(write.decision, "deny");

  const read = runGuard({ ...base, tool_name: "Read", tool_input: { file_path: WATCHED } });
  assert.equal(read.status, 0, "Read still passes");
  assert.equal(read.decision, "continue");

  const writeUnwatched = runGuard({ ...base, tool_name: "Write", tool_input: { file_path: "notes.txt", content: "x" } });
  assert.equal(writeUnwatched.status, 0, "Write on an unwatched path still passes");

  const applyPatch = runGuard({ ...base, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** End Patch" } });
  assert.equal(
    applyPatch.status,
    0,
    "apply_patch stays RECOGNIZED (mutation-capable, no file_path read here) — refusing a known tool would break the Codex lane, and its target extraction is that lane's job",
  );

  const noTool = runGuard({ ...base, hook_event_name: "PreToolUse" });
  assert.equal(noTool.status, 0, "a payload with NO tool_name is not an unknown tool — unchanged passthrough");
});

test("B7 SSOT: one classification table decides (lib/tool-classes.js), and it is total", () => {
  const tc = require(path.join(REPO, ".claude", "hooks", "lib", "tool-classes.js"));
  assert.equal(typeof tc.classifyTool, "function", "classifyTool must exist in the classification SSOT");
  assert.equal(tc.classifyTool("Write"), "mutation");
  assert.equal(tc.classifyTool("Edit"), "mutation");
  assert.equal(tc.classifyTool("NotebookEdit"), "mutation");
  assert.equal(tc.classifyTool("apply_patch"), "mutation");
  assert.equal(tc.classifyTool("Read"), "non-mutation");
  assert.equal(tc.classifyTool("Bash"), "non-mutation");
  assert.equal(tc.classifyTool("Grep"), "non-mutation");
  assert.equal(tc.classifyTool("Task"), "non-mutation");
  assert.equal(tc.classifyTool("Patch"), "unknown");
  assert.equal(tc.classifyTool("frobnicate_tool"), "unknown");
  // AMENDMENT (compliance blocker, 2026-10-08): the csq-messaging MCP tools are
  // classified EXPLICITLY non-repo-mutating so they never ride the unknown path.
  assert.equal(tc.classifyTool("mcp__csq-messaging__send"), "non-mutation");
  assert.equal(tc.classifyTool("mcp__csq-messaging__reply"), "non-mutation");
  assert.equal(tc.classifyTool("mcp__csq-messaging__ack"), "non-mutation");
  assert.equal(tc.classifyTool("mcp__csq-messaging__set_name"), "non-mutation");
  assert.equal(tc.classifyTool("mcp__csq-messaging__inbox"), "non-mutation");
  assert.equal(tc.classifyTool("mcp__csq-messaging__list_sessions"), "non-mutation");
});
