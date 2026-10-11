#!/usr/bin/env node
/*
 * Audit fixtures for `.claude/codex-mcp-guard/extract-policies.mjs` —
 * the FF-AC6-1 marker-gating + multi-tool-matcher-resolution predicates.
 *
 * Per `rules/cc-artifacts.md` Rule 9 + `rules/hook-output-discipline.md`
 * MUST-4: one fixture per scope-restriction predicate the extractor
 * relies on. The predicates exercised here:
 *
 *   P1  Bash matcher          → shell + unified_exec (never apply_patch)
 *   P2  edit matcher + MARKER  → apply_patch (the @coc-codex-edit-gate
 *                                stateless-trust-gate opt-in, FF-AC6-1 AC#1)
 *   P3  edit matcher, NO marker → EXCLUDED from apply_patch (the cc-only
 *                                coordination-guard exclusion, FF-AC6-1 AC#2)
 *   P4  multi-tool matcher
 *       "Edit|Write|MultiEdit|NotebookEdit" resolves (the DF-AC6-1
 *       brittle-exact-match root-cause regression guard). The matcher
 *       deliberately KEEPS the removed-from-CC MultiEdit token: loom's
 *       own settings.json dropped it (journal/0276), but an OLDER
 *       consumer's settings may still carry it — this fixture locks the
 *       legacy MultiEdit→apply_patch fan-out in matcherToCodexTools()
 *       so stale consumer matchers never silently drop the edit lane.
 *   P5  dual registration (Bash + edit matcher) + MARKER → all three
 *       tools; the marker gates ONLY the apply_patch portion
 *   P12 dispatcher expansion, single-hook group → the dispatch-registry.json
 *       groups are injected (the live consolidated shape, unchanged)
 *   P13 dispatcher + CO-RESIDENT direct hook in the SAME group → registry
 *       groups STILL injected AND the co-resident hook keeps its own policy.
 *       GREEN pole; against the pre-fix `hs.length === 1` gate this shape
 *       collapsed to a registry-less table with the extraction still exiting 0
 *   P14 TWO dispatcher commands in one group → registry groups injected ONCE
 *       (no duplicated on_incomplete declaration sets)
 *   P15 the P13 shape with an ABSENT registry → typed refusal
 *       `matcher-map-registry-unreadable`. RED pole — the pre-fix gate never
 *       recognized the mixed group, so it refused nothing and passed the
 *       collapsed table through silently
 *
 * Structural probe (per `rules/probe-driven-verification.md` MUST-3):
 * file-level set membership of the extractor's `policies` output —
 * exit code is the signal, no lexical scan of prose.
 *
 * Invocation:  node .claude/audit-fixtures/extract-policies/run.mjs
 * Exit 0 = all cases pass; 1 = at least one regression.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = path.resolve(
  HERE,
  "..",
  "..",
  "codex-mcp-guard",
  "extract-policies.mjs",
);

const { extractPolicies, buildHookMatcherMap, HookMatcherMapError } =
  await import(pathToFileURL(EXTRACTOR).href);

// Synthetic hooks. Each carries a Shape-D predicate (severity:"block"
// consumed by emit()) so it is a realistic policy candidate; the
// MARKER comment is the only difference between a stateless gate and a
// coordination guard.
const MARKER = "@coc-codex-edit-gate";
function hookBody(name, withMarker) {
  return `#!/usr/bin/env node
/**
 * ${name}${withMarker ? `\n * ${MARKER} — stateless trust gate; fans out to apply_patch.` : ""}
 */
const { emit } = require("./lib/instruct-and-wait.js");
function guard(payload) {
  return { severity: "block", reason: "${name} fired" };
}
const out = guard({});
emit({ severity: out.severity });
`;
}

const SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/bash-gate.js"' },
        ],
      },
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stateless-edit-gate.js"' },
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/coordination-guard.js"' },
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dual-gate.js"' },
        ],
      },
      // dual-gate is ALSO registered under Bash (P5).
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dual-gate.js"' },
        ],
      },
    ],
  },
};

const HOOKS = {
  "bash-gate.js": hookBody("bash-gate", false), // P1: Bash matcher, no marker
  "stateless-edit-gate.js": hookBody("stateless-edit-gate", true), // P2: edit + marker
  "coordination-guard.js": hookBody("coordination-guard", false), // P3: edit, no marker
  "dual-gate.js": hookBody("dual-gate", true), // P5: Bash+edit + marker
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-policies-fx-"));
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(HOOKS)) {
    fs.writeFileSync(path.join(hooksDir, name), body);
  }
  // Minimal lib stub so the hook bodies are syntactically resolvable if
  // ever required(); the extractor only reads source, never executes.
  fs.writeFileSync(
    path.join(hooksDir, "lib", "instruct-and-wait.js"),
    "module.exports = { emit() {} };\n",
  );
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify(SETTINGS, null, 2),
  );
  // Declared policy exclusion (2026-10-09 ruling): P3's hook is edit-matcher,
  // marker-less and refusal-capable, so the extractor REFUSES unless this row
  // declares it. The reference assertion (P3: absent from apply_patch) is
  // unchanged; the DECLARATION is what keeps it an accepted omission.
  fs.mkdirSync(path.join(root, ".claude", "codex-mcp-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "codex-mcp-guard", "policy-exclusions.json"),
    JSON.stringify({
      exclusions: [{
        hook: "coordination-guard.js",
        reason: "fixture declaration: edit-matcher guard deliberately excluded from the Codex apply_patch lane (FF-AC6-1 AC#2) so the extractor may complete without a policy for it.",
        compensating_control: "fixture-only; the real corpus records measured reasons per row.",
      }],
    }),
  );
  return { root, hooksDir, settingsPath: path.join(root, ".claude", "settings.json") };
}

function filesFor(policies, tool) {
  return new Set((policies[tool] || []).map((e) => e.source_file));
}

const cases = [];
function check(id, name, cond, detail) {
  cases.push({ id, name, pass: !!cond, detail });
}

const { root, hooksDir, settingsPath } = setup();
try {
  const res = extractPolicies(hooksDir, { settingsPath });
  const shell = filesFor(res.policies, "shell");
  const unified = filesFor(res.policies, "unified_exec");
  const apply = filesFor(res.policies, "apply_patch");

  // P1 — Bash matcher → shell + unified_exec, NEVER apply_patch.
  check("01", "bash-gate→shell/unified_exec only",
    shell.has("bash-gate.js") && unified.has("bash-gate.js") && !apply.has("bash-gate.js"),
    `shell=${shell.has("bash-gate.js")} unified=${unified.has("bash-gate.js")} apply=${apply.has("bash-gate.js")}`);

  // P2 — edit matcher + MARKER → apply_patch (AC#1).
  check("02", "stateless-edit-gate (marker)→apply_patch",
    apply.has("stateless-edit-gate.js") && !shell.has("stateless-edit-gate.js"),
    `apply=${apply.has("stateless-edit-gate.js")}`);

  // P3 — edit matcher, NO marker → EXCLUDED from apply_patch (AC#2).
  check("03", "coordination-guard (no marker) EXCLUDED from apply_patch",
    !apply.has("coordination-guard.js"),
    `apply=${apply.has("coordination-guard.js")} (MUST be false)`);

  // P4 — the 4-tool matcher resolved at all (DF-AC6-1 regression guard):
  //      if it had silently dropped, apply_patch would be empty.
  check("04", "multi-tool edit matcher resolves (DF-AC6-1 guard)",
    apply.size > 0,
    `apply_patch entries=${apply.size}`);

  // P5 — dual registration + marker → shell + unified_exec + apply_patch.
  check("05", "dual-gate (Bash+edit+marker)→all three tools",
    shell.has("dual-gate.js") && unified.has("dual-gate.js") && apply.has("dual-gate.js"),
    `shell=${shell.has("dual-gate.js")} unified=${unified.has("dual-gate.js")} apply=${apply.has("dual-gate.js")}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// P6–P11 — matcher-map FAIL-CLOSED fence (loom#S73-M5)
// ────────────────────────────────────────────────────────────────
// buildHookMatcherMap previously degraded to an EMPTY Map on a missing,
// unreadable, or unparseable settings.json, and that empty map is the sole
// input to the file-level `policies` table — so a silently-empty policy table
// propagated to every distribution target, indistinguishable from a populated
// one at every surface in between.
//
// BIPOLAR by construction: the RED poles assert the REFUSAL IDENTITY (the
// typed error + its `code`), never merely "something threw" — an unrelated
// TypeError must NOT score as the fence firing. The GREEN poles prove the
// fence did not simply break the happy path, and that the narrow explicit
// opt-out the validator-13 shape fixtures depend on still returns cleanly.

// Capture the refusal identity. Returns the error's class name + code, so a
// case can assert on WHICH refusal fired rather than on the mere fact of a
// throw.
function refusalOf(fn) {
  try {
    fn();
    return { threw: false, typed: false, code: null, message: "" };
  } catch (e) {
    return {
      threw: true,
      typed: e instanceof HookMatcherMapError,
      name: e?.name,
      code: e?.code ?? null,
      message: e?.message ?? "",
    };
  }
}

// Scratch root carrying a real hooks dir; each case supplies its own settings.
const fx = fs.mkdtempSync(path.join(os.tmpdir(), "extract-policies-failclosed-"));
try {
  const hooksDir = path.join(fx, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(HOOKS)) {
    fs.writeFileSync(path.join(hooksDir, name), body);
  }
  fs.writeFileSync(
    path.join(hooksDir, "lib", "instruct-and-wait.js"),
    "module.exports = { emit() {} };\n",
  );
  // P17/P18's subject: a Bash+edit DUAL-registered hook without the marker —
  // the PARTIAL-coverage shape the widened refusal must see.
  fs.writeFileSync(path.join(hooksDir, "dual-ungated.js"), hookBody("dual-ungated", false));
  // fx declares BOTH marker-less edit-capable fixtures, so P10's GREEN run and
  // P18's declared-partial run are silent while P16/P17 (settings paths with no
  // sibling exclusions) are the RED poles.
  fs.mkdirSync(path.join(fx, "codex-mcp-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(fx, "codex-mcp-guard", "policy-exclusions.json"),
    JSON.stringify({
      exclusions: [
        {
          hook: "coordination-guard.js",
          reason: "fixture declaration: edit-matcher guard deliberately excluded from the Codex apply_patch lane (FF-AC6-1 AC#2) so the extractor may complete without a policy for it.",
          compensating_control: "fixture-only; the real corpus records measured reasons per row.",
        },
        {
          hook: "dual-ungated.js",
          reason: "fixture declaration: dual-registered marker-less hook whose apply_patch omission is declared (the PARTIAL-coverage GREEN pole).",
          compensating_control: "fixture-only; the real corpus records measured reasons per row.",
        },
      ],
    }),
  );

  const goodSettings = path.join(fx, "good-settings.json");
  fs.writeFileSync(goodSettings, JSON.stringify(SETTINGS, null, 2));

  // P6 — RED: settings.json ABSENT under the fail-closed default.
  const r6 = refusalOf(() =>
    buildHookMatcherMap(path.join(fx, "does-not-exist.json")),
  );
  check("06", "absent settings → typed matcher-map-settings-missing",
    r6.typed && r6.code === "matcher-map-settings-missing",
    `typed=${r6.typed} code=${r6.code}`);

  // P7 — RED: settings.json present but NOT valid JSON.
  const badJson = path.join(fx, "unparseable-settings.json");
  fs.writeFileSync(badJson, "{ this is not json ");
  const r7 = refusalOf(() => buildHookMatcherMap(badJson));
  check("07", "unparseable settings → typed matcher-map-settings-unparseable",
    r7.typed && r7.code === "matcher-map-settings-unparseable",
    `typed=${r7.typed} code=${r7.code}`);

  // P8 — RED: parses cleanly, yields ZERO hook→matcher bindings. The arm that
  // catches a structurally-valid settings.json whose PreToolUse set resolves
  // to nothing — the case that reads most like success.
  const emptySettings = path.join(fx, "empty-settings.json");
  fs.writeFileSync(emptySettings, JSON.stringify({ hooks: { PreToolUse: [] } }));
  const r8 = refusalOf(() => buildHookMatcherMap(emptySettings));
  check("08", "zero-entry settings → typed matcher-map-empty",
    r8.typed && r8.code === "matcher-map-empty",
    `typed=${r8.typed} code=${r8.code}`);

  // P9 — RED: settings path is a SYMLINK. safeReadFileSync opens O_NOFOLLOW
  // so this raises ELOOP — the #569 emit-lane source-read class the guard
  // exists to surface, and exactly what the former `catch { return map; }`
  // swallowed into an empty table. existsSync FOLLOWS the link (so this is
  // NOT the absent arm); the open then refuses to.
  const linkSettings = path.join(fx, "linked-settings.json");
  fs.symlinkSync(goodSettings, linkSettings);
  const r9 = refusalOf(() => buildHookMatcherMap(linkSettings));
  check("09", "symlinked settings (O_NOFOLLOW/ELOOP) → typed matcher-map-settings-unreadable",
    r9.typed && r9.code === "matcher-map-settings-unreadable",
    `typed=${r9.typed} code=${r9.code}`);

  // P10 — GREEN: a well-formed settings.json still builds, through the REAL
  // entry point, with a populated policy table. Proves the fence did not
  // break the happy path.
  let green = { ok: false, detail: "did not run" };
  try {
    const res = extractPolicies(hooksDir, { settingsPath: goodSettings });
    const total = Object.values(res.policies).reduce((a, p) => a + p.length, 0);
    green = { ok: total > 0, detail: `policy entries=${total}` };
  } catch (e) {
    green = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("10", "well-formed settings still builds a POPULATED table (fence spares happy path)",
    green.ok, green.detail);

  // P11 — GREEN: the narrow explicit opt-out. requireMatcherMap:false is what
  // the validator-13 shape fixtures pass (they read predicates[].shape only
  // and have no sibling settings.json); it must still return cleanly.
  let optOut = { ok: false, detail: "did not run" };
  try {
    const m = buildHookMatcherMap(path.join(fx, "does-not-exist.json"), {
      required: false,
    });
    optOut = { ok: m instanceof Map && m.size === 0, detail: `map.size=${m.size}` };
  } catch (e) {
    optOut = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("11", "explicit requireMatcherMap:false opt-out returns cleanly",
    optOut.ok, optOut.detail);

  // ────────────────────────────────────────────────────────────────
  // P16–P18 — policy-coverage refusal (2026-10-09; widened the same day per
  // the Round-1 correctness MEDIUM: the refusal fires on ZERO APPLY_PATCH
  // entries, not only zero-in-every-tool, so a Bash+edit dual-registered
  // hook can no longer skip the edit lane silently).
  // ────────────────────────────────────────────────────────────────

  // P16 — RED: edit-only guard, undeclared (settings path with no sibling
  // exclusions file).
  const noDeclDir = path.join(fx, "no-decl");
  fs.mkdirSync(noDeclDir, { recursive: true });
  const noDeclSettings = path.join(noDeclDir, "settings.json");
  fs.writeFileSync(noDeclSettings, JSON.stringify(SETTINGS, null, 2));
  const r16 = refusalOf(() => extractPolicies(hooksDir, { settingsPath: noDeclSettings }));
  check("16", "undeclared edit-only guard → typed policy-coverage-gap naming the guard",
    r16.typed && r16.code === "policy-coverage-gap" && /coordination-guard\.js/.test(r16.message),
    `typed=${r16.typed} code=${r16.code} names=${/coordination-guard\.js/.test(r16.message)}`);

  // P17 — RED: the PARTIAL shape — Bash+edit dual registration WITHOUT the
  // marker keeps shell/unified_exec coverage while its apply_patch entry is
  // gated away. Pre-widening this was invisible (union-over-all-tools).
  const PARTIAL_GROUP = [
    {
      matcher: "Bash|Edit",
      hooks: [
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/dual-ungated.js"' },
      ],
    },
  ];
  const partialDir = path.join(fx, "partial-nodecl");
  fs.mkdirSync(partialDir, { recursive: true });
  const partialSettings = path.join(partialDir, "settings.json");
  fs.writeFileSync(partialSettings, JSON.stringify({ hooks: { PreToolUse: PARTIAL_GROUP } }, null, 2));
  const r17 = refusalOf(() => extractPolicies(hooksDir, { settingsPath: partialSettings }));
  check("17", "dual-registered marker-less hook (PARTIAL coverage) → typed policy-coverage-gap",
    r17.typed && r17.code === "policy-coverage-gap" && /dual-ungated\.js/.test(r17.message) && /PARTIAL/.test(r17.message),
    `typed=${r17.typed} code=${r17.code} partial=${/PARTIAL/.test(r17.message)} names=${/dual-ungated\.js/.test(r17.message)}`);

  // P18 — GREEN: the same partial shape, DECLARED in fx's exclusions → silent,
  // and the shell half of its coverage survives (a declared exclusion removes
  // nothing; it records the edit-lane omission).
  fs.writeFileSync(
    path.join(fx, "dual-ungated-settings.json"),
    JSON.stringify({ hooks: { PreToolUse: PARTIAL_GROUP } }, null, 2),
  );
  let partialGreen = { ok: false, detail: "did not run" };
  try {
    const res = extractPolicies(hooksDir, { settingsPath: path.join(fx, "dual-ungated-settings.json") });
    const shell = filesFor(res.policies, "shell");
    const apply = filesFor(res.policies, "apply_patch");
    partialGreen = {
      ok: shell.has("dual-ungated.js") && !apply.has("dual-ungated.js"),
      detail: `shell=${shell.has("dual-ungated.js")} apply=${apply.has("dual-ungated.js")}`,
    };
  } catch (e) {
    partialGreen = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("18", "declared partial hook → silent, shell coverage retained, apply_patch omitted",
    partialGreen.ok, partialGreen.detail);

  // P19–P22 — exclusions-file ROW VALIDATION (R3 security F1: the malformed
  // refusals at extract-policies.mjs:438-457 had NO positive control anywhere —
  // removing the reason-length conjunct silenced real hooks with a stub reason
  // and no suite redded). One RED per malformed class + a 20-char boundary GREEN.
  const mkExclDir = (name, exclusionsText) => {
    const dir = path.join(fx, name);
    fs.mkdirSync(path.join(dir, "codex-mcp-guard"), { recursive: true });
    const settings = path.join(dir, "settings.json");
    fs.writeFileSync(settings, JSON.stringify(SETTINGS, null, 2));
    fs.writeFileSync(path.join(dir, "codex-mcp-guard", "policy-exclusions.json"), exclusionsText);
    return settings;
  };
  const r19 = refusalOf(() =>
    extractPolicies(hooksDir, { settingsPath: mkExclDir("excl-badjson", "{ not json ") }),
  );
  check("19", "exclusions file not valid JSON → typed policy-exclusions-malformed",
    r19.typed && r19.code === "policy-exclusions-malformed",
    `typed=${r19.typed} code=${r19.code}`);

  const shortReasonRow = (reason, control) =>
    JSON.stringify({
      exclusions: [{ hook: "coordination-guard.js", reason, compensating_control: control }],
    });
  const r20 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-shortreason", shortReasonRow("x".repeat(19), "control present")),
    }),
  );
  check("20", "19-char reason → typed policy-exclusions-malformed (length floor)",
    r20.typed && r20.code === "policy-exclusions-malformed",
    `typed=${r20.typed} code=${r20.code}`);

  const r21 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-emptycontrol", shortReasonRow("a substantive reason of legal length", "")),
    }),
  );
  check("21", "empty compensating_control → typed policy-exclusions-malformed",
    r21.typed && r21.code === "policy-exclusions-malformed",
    `typed=${r21.typed} code=${r21.code}`);

  // P22 — GREEN boundary: the SAME row with a reason of exactly 20 chars is
  // ACCEPTED (the 19/20 pair pins the length predicate in both directions).
  let exclAccept = { ok: false, detail: "did not run" };
  try {
    const res = extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-accept20", shortReasonRow("y".repeat(20), "control present")),
    });
    exclAccept = {
      ok: !filesFor(res.policies, "apply_patch").has("coordination-guard.js"),
      detail: `apply=${filesFor(res.policies, "apply_patch").has("coordination-guard.js")}`,
    };
  } catch (e) {
    exclAccept = { ok: false, detail: `threw ${e?.name}: ${e?.code ?? e?.message}` };
  }
  check("22", "exactly-20-char reason row → ACCEPTED (boundary GREEN; declared edit-only guard stays out of apply_patch)",
    exclAccept.ok, exclAccept.detail);

  // P23/P24 — the SILENT direction of the same predicate (R3-security round-2
  // residual i): readPolicyExclusions TRIMS reason/control before validating, so
  // a whitespace-only reason is refused by the length floor and a whitespace-only
  // control is refused as empty. Dropping either `.trim()` (extract-policies.mjs
  // ::readPolicyExclusions' per-field derivations) leaves all earlier cases green
  // while a `reason:"   ".repeat(9)` stub row then rides the exclusion — P23/P24
  // are the poles that red on that drop. (Anchored by symbol after the first
  // draft's :452-453 citation rotted — the same numbers-rot class the hold lane
  // recorded; the illustration was `" ".repeat(25)`, itself off the pole's 27.)
  const r23 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-wsreason", shortReasonRow("   ".repeat(9), "control present")),
    }),
  );
  check("23", "whitespace-only reason (27 chars pre-trim) → typed policy-exclusions-malformed (trim pole)",
    r23.typed && r23.code === "policy-exclusions-malformed",
    `typed=${r23.typed} code=${r23.code}`);

  const r24 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-wscontrol", shortReasonRow("a substantive reason of legal length", "   ")),
    }),
  );
  check("24", "whitespace-only compensating_control → typed policy-exclusions-malformed (trim pole)",
    r24.typed && r24.code === "policy-exclusions-malformed",
    `typed=${r24.typed} code=${r24.code}`);

  // P25–P27 — the REMAINING predicate arms (R3-correctness round-2 residual
  // ii: two drops survived every earlier case). (a) Dropping the `!hook`
  // arm of `readPolicyExclusions`' row conjunct (extract-policies.mjs:454)
  // lets a row with an empty `hook` ride validation — no case carried one.
  // (b) Mutating the :444 guard `Array.isArray(...) ? ... : null` to `: []`
  // lets a shape-less file read as "no exclusions" — no case carried one.
  // Each asserts the TYPED code, which keeps discriminating even when the
  // mutant falls through to the NEXT refusal class: with the row accepted,
  // the still-undeclared edit-guard throws policy-coverage-gap, a DIFFERENT
  // typed code (`policy-exclusions-malformed` is the subject).
  const r25 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir(
        "excl-emptyhook",
        JSON.stringify({
          exclusions: [
            { hook: "", reason: "a substantive reason of legal length", compensating_control: "control present" },
          ],
        }),
      ),
    }),
  );
  check("25", "empty `hook` in an exclusions row → typed policy-exclusions-malformed (hook arm pole)",
    r25.typed && r25.code === "policy-exclusions-malformed",
    `typed=${r25.typed} code=${r25.code}`);

  const r26 = refusalOf(() =>
    extractPolicies(hooksDir, { settingsPath: mkExclDir("excl-noarray", "{}") }),
  );
  check("26", "exclusions file with NO `exclusions` key → typed policy-exclusions-malformed",
    r26.typed && r26.code === "policy-exclusions-malformed",
    `typed=${r26.typed} code=${r26.code}`);

  const r27 = refusalOf(() =>
    extractPolicies(hooksDir, {
      settingsPath: mkExclDir("excl-nullarray", '{"exclusions": null}'),
    }),
  );
  check("27", "`exclusions: null` → typed policy-exclusions-malformed (non-array pole)",
    r27.typed && r27.code === "policy-exclusions-malformed",
    `typed=${r27.typed} code=${r27.code}`);
} finally {
  fs.rmSync(fx, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────
// P12–P15 — dispatcher expansion (dispatch.js → dispatch-registry.json)
// ────────────────────────────────────────────────────────────────
// A settings group whose command list contains a `dispatch.js <Event>`
// entry is the CONSOLIDATED registration form: the hooks behind it live in
// `<settings dir>/hooks/dispatch-registry.json` and MUST be expanded back to
// per-hook groups, or every consolidated guard drops out of the Codex policy
// table. The extractor originally recognized that form only when the
// dispatcher was the group's SOLE command (`hs.length === 1`); a group that
// ALSO carried a directly-registered hook fell through to the pass-through
// arm, injected ZERO registry groups, and the extraction still exited 0 —
// a populated-but-SHORT table, the one shape the `matcher-map-empty` fence
// cannot see. These cases lock the multi-hook shapes and both poles.
const DISPATCH_SHA = "0123456789abcdef".repeat(4); // 64 hex — the live optional pin shape
const DISPATCH_CMD = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" PreToolUse --registry-sha256=${DISPATCH_SHA}`;

// The registry's per-hook `on_incomplete` declarations are compared against
// each hook's SOURCE by policy-outcome.js::capabilityMetadata; "deny" pairs
// with hookBody()'s severity:"block" literal, so the capability-drift fence
// stays silent on the happy path.
const DISPATCH_REGISTRY = {
  schema: 1,
  events: {
    PreToolUse: {
      groups: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/registry-shell-gate.js"', timeout: 20, on_incomplete: "deny" },
          ],
        },
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [
            { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/registry-edit-gate.js"', timeout: 20, on_incomplete: "deny" },
          ],
        },
      ],
    },
  },
};

const DISPATCH_HOOKS = {
  // `dispatch.js` exists on disk in the live tree, so the fixture mirrors
  // that: pre-fix it LEAKS into the policy map as a bogus entry (the
  // observable half of the collapse — the registry half is its absence).
  "dispatch.js": hookBody("dispatch", false),
  "registry-shell-gate.js": hookBody("registry-shell-gate", false),
  "registry-edit-gate.js": hookBody("registry-edit-gate", true), // marker → apply_patch
  "co-resident.js": hookBody("co-resident", false),
  "plain-bash.js": hookBody("plain-bash", false),
};

function setupDispatchTree({ dispatchers, mixed, withRegistry }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-policies-dispatch-"));
  const hooksDir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(path.join(hooksDir, "lib"), { recursive: true });
  for (const [name, body] of Object.entries(DISPATCH_HOOKS)) {
    fs.writeFileSync(path.join(hooksDir, name), body);
  }
  fs.writeFileSync(
    path.join(hooksDir, "lib", "instruct-and-wait.js"),
    "module.exports = { emit() {} };\n",
  );
  const dispatcherHooks = Array.from({ length: dispatchers }, () => ({
    type: "command",
    command: DISPATCH_CMD,
  }));
  const preToolUse = [
    {
      // The live dispatcher group's matcher (settings.json).
      matcher: "*",
      hooks: mixed
        ? [...dispatcherHooks, { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/co-resident.js"' }]
        : dispatcherHooks,
    },
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/plain-bash.js"' },
      ],
    },
  ];
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: preToolUse } }, null, 2),
  );
  // The mixed shape registers `co-resident.js` directly on the `*` matcher —
  // edit-capable and marker-less — so the widened policy-coverage refusal
  // demands a declared row for it; without one P13 would measure the refusal
  // instead of the dispatcher expansion it exists to pin.
  fs.mkdirSync(path.join(root, ".claude", "codex-mcp-guard"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "codex-mcp-guard", "policy-exclusions.json"),
    JSON.stringify({
      exclusions: [{
        hook: "co-resident.js",
        reason: "fixture declaration: direct hook on the wildcard dispatcher group is edit-capable and marker-less; its apply_patch omission is declared so the dispatcher-expansion cases measure expansion, not the refusal.",
        compensating_control: "fixture-only; the real corpus records measured reasons per row.",
      }],
    }),
  );
  if (withRegistry) {
    fs.writeFileSync(
      path.join(hooksDir, "dispatch-registry.json"),
      JSON.stringify(DISPATCH_REGISTRY, null, 2),
    );
  }
  return { root, hooksDir, settingsPath: path.join(root, ".claude", "settings.json") };
}

function reportMap(res) {
  const shell = [...filesFor(res.policies, "shell")].sort();
  const unified = [...filesFor(res.policies, "unified_exec")].sort();
  const apply = [...filesFor(res.policies, "apply_patch")].sort();
  return `shell=[${shell.join(",")}] unified=[${unified.join(",")}] apply=[${apply.join(",")}]`;
}

// P12 — UNCHANGED CONTROL: the live single-hook dispatcher shape expands as
// before (registry groups injected, the dispatcher entry itself consumed).
{
  const { root, hooksDir, settingsPath } = setupDispatchTree({ dispatchers: 1, mixed: false, withRegistry: true });
  try {
    const res = extractPolicies(hooksDir, { settingsPath });
    const shell = filesFor(res.policies, "shell");
    const unified = filesFor(res.policies, "unified_exec");
    const apply = filesFor(res.policies, "apply_patch");
    check("12", "single-hook dispatcher group → registry groups injected (live shape, unchanged)",
      shell.has("registry-shell-gate.js") && shell.has("plain-bash.js") &&
      unified.has("registry-shell-gate.js") && unified.has("plain-bash.js") &&
      apply.has("registry-edit-gate.js") &&
      !shell.has("dispatch.js") &&
      shell.size === 2 && unified.size === 2 && apply.size === 1,
      reportMap(res));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// P13 — GREEN POLE: dispatcher + co-resident direct hook in the SAME group.
// The registry groups MUST still be injected (pre-fix they vanished) and the
// co-resident hook MUST keep its own policy as a residual group.
{
  const { root, hooksDir, settingsPath } = setupDispatchTree({ dispatchers: 1, mixed: true, withRegistry: true });
  try {
    const res = extractPolicies(hooksDir, { settingsPath });
    const shell = filesFor(res.policies, "shell");
    const unified = filesFor(res.policies, "unified_exec");
    const apply = filesFor(res.policies, "apply_patch");
    check("13", "dispatcher + co-resident in ONE group → registry injected AND co-resident has its own policy",
      shell.has("registry-shell-gate.js") &&
      shell.has("co-resident.js") &&
      shell.has("plain-bash.js") &&
      unified.has("registry-shell-gate.js") && unified.has("co-resident.js") &&
      apply.has("registry-edit-gate.js") &&
      !shell.has("dispatch.js") &&
      shell.size === 3 && unified.size === 3 && apply.size === 1,
      `${reportMap(res)} (pre-fix: registry-shell-gate.js absent, dispatch.js leaked into shell)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// P14 — TWO dispatcher commands in one group: handled, and the registry
// groups are injected ONCE. `onIncomplete` is the observable half of a
// double injection: buildHookMatcherMap accumulates one declaration entry
// per registered occurrence, so injecting spec.groups twice would list
// ["deny","deny"] — duplicates a single injection cannot produce.
{
  const { root, hooksDir, settingsPath } = setupDispatchTree({ dispatchers: 2, mixed: true, withRegistry: true });
  try {
    const m = buildHookMatcherMap(settingsPath);
    const decls = m.onIncomplete.get("registry-shell-gate.js") || [];
    check("14", "two dispatcher commands in one group → registry groups injected ONCE",
      decls.length === 1 && decls[0] === "deny" &&
      m.has("registry-shell-gate.js") && m.has("registry-edit-gate.js") &&
      m.has("co-resident.js") && m.has("plain-bash.js") &&
      !m.has("dispatch.js"),
      `declarations=${JSON.stringify(decls)} registry-shell=${m.has("registry-shell-gate.js")} co-resident=${m.has("co-resident.js")} dispatch=${m.has("dispatch.js")}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// P15 — RED POLE: the same multi-hook shape with an ABSENT registry. The
// dispatcher demonstrably EXISTS and its registry cannot be read, so the
// extractor MUST refuse with the typed identity — the arm the pre-fix
// `hs.length === 1` gate never reached, letting the collapsed table through
// with exit 0 and no diagnostic.
{
  const { root, hooksDir, settingsPath } = setupDispatchTree({ dispatchers: 1, mixed: true, withRegistry: false });
  try {
    const r = refusalOf(() => extractPolicies(hooksDir, { settingsPath }));
    check("15", "mixed group + ABSENT registry → typed matcher-map-registry-unreadable (RED pole)",
      r.typed && r.code === "matcher-map-registry-unreadable",
      `threw=${r.threw} typed=${r.typed} code=${r.code}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(
  `\n${cases.length - failed}/${cases.length} cases pass\n`,
);
process.exit(failed === 0 ? 0 : 1);
