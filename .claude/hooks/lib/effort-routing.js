/**
 * effort-routing.js — the EFFORT ROUTING decision: every subagent launch carries the effort its ROLE
 * maps to in ONE data table (`effort-routing-policy.json`, beside this file).
 *
 * Owner decision 2026-10-12. Measured basis, which is why this is enforced rather than advised: the
 * per-dispatch effort parameter IS honoured on both runtimes — Claude (low x3: 87-88k tokens, 2 tool
 * calls; high x3: 95-208k, 5-8 calls; high found the root cause, low did not) and Codex (reasoning
 * tokens low 18-42 vs high 326-661). So the level a launch carries decides what the lane can do, and
 * a lane launched at the wrong level is a lane that silently cannot do its job. A frontmatter
 * `effort:` key is NOT in scope: it is unverified, and Codex's contract never reads it.
 *
 * THREE PARSED FIELDS, compared — never a reading of prose:
 *   1. the ROLE   — the brief's FIRST non-empty line, `ROLE: <role>`, exactly;
 *   2. the TABLE  — `effort-routing-policy.json`, schema-checked (`validateRoutingTable`);
 *   3. the EFFORT — the launch's own tool parameter (`effort`; Codex `reasoning_effort` is
 *                   normalized to it in `codex-hook-runtime.js::normalizeNativeInput`).
 * A verdict built only from parsed fields is what `hook-output-discipline.md` MUST-2 names
 * block-grade, so the guard that consumes this module (`dispatch-contract-guard.js`, with its re-task
 * entry `dispatch-retask-guard.js`) BLOCKS on it.
 *
 * FAIL-CLOSED, deliberately — the one arm of that guard that is. An invalid, unparseable or ABSENT
 * table blocks EVERY launch with a `routing table invalid` reason; a missing role line, an unknown
 * role or a missing effort blocks. There is no built-in default table and no default level: a
 * default would emit the same verdict whether or not anyone had routed the launch
 * (`instrument-discipline.md` MUST-1), and a gate that guesses its own inputs is not a gate.
 *
 * THE OVERRIDE is the NEXT non-empty line after the role, `EFFORT-OVERRIDE: <level> — <reason>`
 * (em-dash; `–`, `--` and `-` are accepted as the separator). It permits ONLY the level it names,
 * and only with a non-empty reason; a malformed override line BLOCKS rather than being ignored,
 * so a typo can never read as "no override requested". The guard RECORDS every honoured override
 * in the shared override use ledger (`override-receipt.js::recordInlineOverride`); an override
 * that cannot be recorded is not honoured.
 *
 * RE-TASKING. A follow-up to an existing agent (`SendMessage`) whose message starts with a ROLE line
 * mapping to a different effort than the agent was LAUNCHED with is blocked — the effort of a running
 * agent cannot be changed by a message, so the only correct remedy is a fresh dispatch. The launch
 * effort comes from the T1 dispatch ledger (`dispatch-ledger.js` launch rows); when it is UNKNOWN —
 * no row, no recorded effort, or rows that disagree — EVERY re-task finding is ADVISORY only,
 * including an unknown role, a malformed override line and an invalid table: a message to an agent
 * with no recorded launch (`main`, a peer, an agent launched before this module existed) is not a
 * re-task this module can judge, and blocking it would refuse a lane's delivery channel. A message
 * to `main` is never a re-task and is not evaluated at all.
 *
 * THE RE-TASK HALF IS A DECLARATION CHECK, NOT A SECURITY CONTROL. It runs only when the follow-up's
 * first line DECLARES a role (`declaresRole`), so the same re-task written without a ROLE line passes
 * unread — the check catches a declared mismatch, it cannot catch an undeclared one. The routing gate
 * is the LAUNCH half; this half saves a wasted turn when the sender states what it is asking for.
 *
 * VERIFICATION (the assurance side, `reconcile-dispatch-delivery.js`): `assessEffortApplication`
 * compares the declared launch effort with what the lane observably did — Codex's own recorded effort
 * when its payload carries one, and for Claude an ADVISORY band check only. ADVISORY on every path.
 *
 * RESIDUALS, stated rather than hidden: a MISLABELLED role cannot be detected (a security review
 * declared `ROLE: extraction` routes to low, consistently and wrongly — the table checks the pairing,
 * not the truth of the label); a Claude `fork` dispatch ignores the effort parameter by harness
 * contract and runs at its PARENT's effort, so a fork launch is BLOCKED (`EFFORT_INAPPLICABLE`)
 * unless its brief carries an `EFFORT-OVERRIDE` line, which is recorded — every fork's effort
 * deviation is audited rather than passed as though the declared level applied. Duplicate keys in the
 * table JSON are caught by a lexical scan rather than a full tokenizer; a key spelled with a JSON
 * escape (which that scan cannot match) is refused outright, since every role name is plain ASCII.
 *
 * NO PROMPT TEXT IS RETAINED. Findings carry bounded evidence; the only reason text that leaves this
 * module is the override reason the guard HASHES into the ledger.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The table schema this module understands. A different version is INVALID, never "best effort". */
const SCHEMA_VERSION = 1;

/** The level vocabulary — the values Claude's Agent/Task `effort` parameter accepts. */
const LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** The table ships beside this module, so every consumer that receives the guard receives it. */
const TABLE_PATH = path.join(__dirname, "effort-routing-policy.json");

/** Top-level keys a valid table may carry. */
const TABLE_KEYS = Object.freeze(["schema_version", "_doc", "roles"]);

/** Lowercase kebab-case, the shape every owner role uses. */
const ROLE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Bound on the table read — the table is a few hundred bytes; anything larger is not this file. */
const TABLE_MAX_BYTES = 64 * 1024;

/**
 * The id every finding here carries. The `agents/` prefix names the delegation-contract family the
 * guard's other block id belongs to; the clause TEXT lives in
 * `skills/30-claude-code-patterns/specialist-delegation-syntax.md` § Effort Routing, because the
 * always-loaded `rules/agents.md` has no injection headroom for it.
 */
const RULE_ID = "agents/effort-routing";

/** The ledger channel an honoured inline override is recorded under. */
const OVERRIDE_CHANNEL = `${RULE_ID}/EFFORT-OVERRIDE`;

/** Tool names this module decides on. */
const LAUNCH_TOOLS = Object.freeze(["Task", "Agent"]);
const RETASK_TOOLS = Object.freeze(["SendMessage"]);
/** The Workflow tool: its script's `agent(` launches fire no PreToolUse of their own (finding ROOT-W1). */
const WORKFLOW_TOOL = "Workflow";

/** The Claude subagent type that inherits its parent's context AND effort; `effort` does not apply. */
const FORK_SUBAGENT_TYPE = "fork";

/** The address of the lead conversation. A message to it reports UP; it is never a re-task. */
const LEAD_RECIPIENT = "main";

const EVIDENCE_MAX = 400;

function clip(s, max = EVIDENCE_MAX) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Keys that appear more than once as an object KEY in raw JSON text. `JSON.parse` keeps the LAST of
 * a duplicated key silently, so `{"x":"low","x":"high"}` would validate as whichever came last. A
 * lexical scan, scoped to the names the parse produced: an unescaped `"<key>"` followed by `:`.
 */
function duplicatedKeys(text, keys) {
  const out = [];
  for (const k of keys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`(?<!\\\\)"${esc}"\\s*:`, "g");
    const n = (text.match(rx) || []).length;
    if (n > 1) out.push(k);
  }
  return out;
}

/**
 * Object KEYS in raw JSON text that are spelled with a backslash escape. The duplicate scan above
 * matches a key by its literal spelling, so `"\u0073ecurity-review"` — which JSON.parse decodes to
 * `security-review` — is invisible to it and would silently win as the later duplicate. Every role
 * name is lowercase ASCII kebab-case and every top-level key is plain ASCII, so a legitimate table
 * never spells a key with an escape; refusing any such key closes the bypass without a tokenizer.
 * Walks every JSON string token and keeps those followed (after whitespace) by `:`.
 */
function escapedKeys(text) {
  const out = [];
  const rx = /"(?:[^"\\]|\\.)*"/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (!m[0].includes("\\")) continue;
    const rest = text.slice(rx.lastIndex);
    if (/^\s*:/.test(rest)) out.push(m[0]);
  }
  return out;
}

/**
 * Validate a parsed table. Pure.
 *
 * @param {unknown} obj
 * @param {string} [rawText] the source text, when available, for the duplicate-key scan
 * @returns {{ok:true, roles:Object<string,string>} | {ok:false, reason:string}}
 */
function validateRoutingTable(obj, rawText) {
  const bad = (reason) => ({ ok: false, reason });
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return bad("the table is not a JSON object");
  const unknown = Object.keys(obj).filter((k) => !TABLE_KEYS.includes(k));
  if (unknown.length) return bad(`unknown top-level key(s): ${unknown.slice(0, 5).join(", ")}`);
  if (obj.schema_version !== SCHEMA_VERSION) {
    return bad(`schema_version must be ${SCHEMA_VERSION}, got ${clip(JSON.stringify(obj.schema_version) ?? "undefined", 40)}`);
  }
  if (own(obj, "_doc") && (!Array.isArray(obj._doc) || obj._doc.some((l) => typeof l !== "string"))) {
    return bad("_doc must be an array of strings");
  }
  const roles = obj.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return bad("roles must be an object");
  const names = Object.keys(roles);
  if (names.length === 0) return bad("roles is empty");
  for (const name of names) {
    if (!ROLE_NAME_RE.test(name)) return bad(`role name ${clip(JSON.stringify(name), 60)} is not lowercase kebab-case`);
    if (!LEVELS.includes(roles[name])) {
      return bad(`role ${name} has unknown effort ${clip(JSON.stringify(roles[name]) ?? "undefined", 40)} (valid: ${LEVELS.join(", ")})`);
    }
  }
  if (typeof rawText === "string") {
    const escaped = escapedKeys(rawText);
    if (escaped.length) return bad(`key(s) spelled with a JSON escape: ${clip(escaped.slice(0, 3).join(", "), 120)}`);
    const dupes = duplicatedKeys(rawText, [...TABLE_KEYS, ...names]);
    if (dupes.length) return bad(`duplicated key(s): ${dupes.slice(0, 5).join(", ")}`);
  }
  const frozen = {};
  for (const name of names) frozen[name] = roles[name];
  return { ok: true, roles: Object.freeze(frozen) };
}

/**
 * Read and validate the table. NEVER throws; an absent, unreadable, oversized or unparseable file is
 * INVALID with a reason — there is no default table.
 *
 * @param {string} [file] defaults to the table shipped beside this module
 */
function loadRoutingTable(file) {
  const target = typeof file === "string" && file ? file : TABLE_PATH;
  let text;
  let fd = null;
  try {
    // NO SYMLINK: the table decides what every launch may carry, so a symlink planted in its place
    // (pointing at a permissive copy) must not be followed. `lstat` refuses one on every platform;
    // `O_NOFOLLOW` closes the swap between that check and the open where the platform has it, and
    // `O_NONBLOCK` keeps a FIFO planted at the path from hanging the open. The size and type are
    // then read from the OPEN descriptor, so they describe the bytes actually read.
    const lst = fs.lstatSync(target);
    if (lst.isSymbolicLink()) return { ok: false, reason: `${path.basename(target)} is a symlink, which is never followed` };
    if (!lst.isFile()) return { ok: false, reason: `${path.basename(target)} is not a regular file` };
    const c = fs.constants;
    fd = fs.openSync(target, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: `${path.basename(target)} is not a regular file` };
    if (st.size > TABLE_MAX_BYTES) return { ok: false, reason: `${path.basename(target)} exceeds ${TABLE_MAX_BYTES} bytes` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString("utf8");
  } catch (e) {
    return { ok: false, reason: `${path.basename(target)} could not be read (${(e && e.code) || "error"})` };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* closing a read fd; nothing to recover */ }
    }
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${path.basename(target)} is not valid JSON` };
  }
  return validateRoutingTable(obj, text);
}

/** "security-review (high), correctness-review (high), …" — the remedy every block message carries. */
function describeRoles(table) {
  if (!table || !table.ok) return "(none — the routing table is invalid)";
  return Object.entries(table.roles).map(([r, l]) => `${r} (${l})`).join(", ");
}

/**
 * Roles a GENERIC launch can pick — a built-in skill dispatching an Explore or general-purpose agent
 * whose brief has no natural role. Offered only when the shipped table carries the role.
 */
const GENERIC_ROLES = Object.freeze([
  ["explore-search", "read-only search or exploration"],
  ["routine-implementation", "routine edits"],
]);

/** How to pass a level, on both runtimes. */
function effortHowTo(level) {
  return `pass effort ${level} — Claude Agent/Task: \`effort: "${level}"\`; Codex spawn_agent: ` +
    `\`reasoning_effort: "${level}"\`; Workflow script: \`agent(prompt, {effort: "${level}"})\``;
}

/**
 * THE SELF-CORRECTION every effort-routing block carries (owner ruling 2026-10-12: a block the agent
 * can see and correct, never one that needs a human). It names the exact corrected first line, the
 * required effort and how to pass it, every valid role from the shipped table, and the roles a
 * generic launch can pick. With a known `role` the corrected line is that role's; without one, each
 * role's exact line is listed. `fresh` frames it for a re-task, whose remedy is a fresh launch.
 */
function remedyText(table, role, fresh) {
  const roles = table && table.ok ? table.roles : null;
  if (!roles) return "";
  const lead = fresh ? "dispatch a FRESH (non-fork) agent and make its brief's" : "make the brief's";
  const out = ["SELF-CORRECT (no human step needed):"];
  if (typeof role === "string" && own(roles, role)) {
    out.push(`${lead} FIRST line exactly \`ROLE: ${role}\` and ${effortHowTo(roles[role])}.`);
  } else {
    out.push(`${lead} FIRST line exactly one of ` +
      Object.entries(roles).map(([r, l]) => `\`ROLE: ${r}\` (effort ${l})`).join(", ") +
      `, and pass that role's effort — Claude Agent/Task: \`effort\`; Codex spawn_agent: \`reasoning_effort\`; ` +
      `Workflow script: the \`effort\` option of \`agent(prompt, {effort})\`.`);
  }
  const generic = GENERIC_ROLES.filter(([r]) => own(roles, r));
  if (generic.length > 0) {
    out.push("A generic launch (a built-in skill dispatching an Explore or general-purpose agent) uses " +
      generic.map(([r, what]) => `\`ROLE: ${r}\` (effort ${roles[r]}) for ${what}`).join(" or ") + ".");
  }
  out.push(`Valid roles (effort): ${describeRoles(table)}.`);
  return out.join(" ");
}

const OVERRIDE_RX = /^EFFORT-OVERRIDE:\s*([A-Za-z]+)\s*(?:—|–|--|-)\s*(.*)$/;

/**
 * Parse the brief's header. Pure.
 *
 * The ROLE is the FIRST non-empty line, trimmed, and must read exactly `ROLE: <role>` (one token).
 * The override is the NEXT non-empty line, if it begins `EFFORT-OVERRIDE:`.
 *
 * @param {string} text
 * @returns {{role:string|null, roleError:string|null, roleCode:"ROLE_MISSING"|"ROLE_MALFORMED"|null,
 *            override:{level:string,reason:string}|null, overrideError:string|null}}
 */
function parseBriefHeader(text) {
  const out = { role: null, roleError: null, roleCode: null, override: null, overrideError: null };
  if (typeof text !== "string") {
    out.roleError = "the brief is not text";
    out.roleCode = "ROLE_MISSING";
    return out;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const first = lines[0];
  if (first === undefined || !first.startsWith("ROLE:")) {
    out.roleError = "the first non-empty line is not `ROLE: <role>`";
    out.roleCode = "ROLE_MISSING";
    return out;
  }
  const m = /^ROLE:\s*(\S+)$/.exec(first);
  if (!m) {
    // A ROLE line IS present but does not parse (`ROLE: x (high)`, `ROLE:`): one code for it on
    // BOTH paths — launch and re-task — so the same input never reads as two different faults.
    out.roleError = "the ROLE line must name exactly one role: `ROLE: <role>`";
    out.roleCode = "ROLE_MALFORMED";
    return out;
  }
  out.role = m[1];
  const second = lines[1];
  if (second !== undefined && second.startsWith("EFFORT-OVERRIDE:")) {
    const o = OVERRIDE_RX.exec(second);
    if (!o) {
      out.overrideError = "the override line must read `EFFORT-OVERRIDE: <level> — <reason>`";
    } else if (!LEVELS.includes(o[1])) {
      out.overrideError = `the override level ${clip(o[1], 20)} is not one of ${LEVELS.join(", ")}`;
    } else if (o[2].trim() === "") {
      out.overrideError = "the override carries no reason; a reason is required";
    } else {
      out.override = { level: o[1], reason: o[2].trim() };
    }
  }
  return out;
}

function finding(severity, code, evidence, extra) {
  return { rule_id: RULE_ID, severity, code, evidence: `${code}: ${evidence}`, ...(extra || {}) };
}

function tableInvalidFinding(table) {
  return finding(
    "block",
    "TABLE_INVALID",
    `routing table invalid — ${clip((table && table.reason) || "no table result", 200)}. Every launch is ` +
      "blocked until .claude/hooks/lib/effort-routing-policy.json validates. SELF-CORRECT (no human step " +
      "needed): restore the SHIPPED table — `git checkout HEAD -- .claude/hooks/lib/effort-routing-policy.json` " +
      "(or re-pull it from your template) — rather than authoring one; then re-issue. Its schema: " +
      "schema_version 1; `roles` maps lowercase kebab-case roles to one of " +
      `${LEVELS.join(", ")}; no other top-level keys.`,
  );
}

/**
 * The launch's declared effort: a non-empty string exactly as the host receives it, or null. Never a
 * default and never TRIMMED — `" high"` is not `high`, so judging the trimmed value would pass a level
 * the host was never given (E3 R2 security M3).
 */
function effortOf(toolInput) {
  const v = toolInput && typeof toolInput === "object" ? toolInput.effort : undefined;
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Decide one LAUNCH. Pure.
 *
 * @param {object} toolInput the PreToolUse `tool_input` (Codex input already normalized)
 * @param {{ok:boolean, roles?:object, reason?:string}} table a `loadRoutingTable` result
 * @returns {{findings:object[], override:null|{role,required,level,reason}}}
 */
function launchArgumentKeys(keys, total = keys.length) {
  const listed = Array.isArray(keys) ? keys : [];
  const count = Number.isSafeInteger(total) && total >= listed.length ? total : listed.length;
  const shown = listed.slice(0, 32).map(key => {
    return typeof key === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : "<invalid-key>";
  });
  if (count > 32) shown.push(`+${count - 32} more`);
  return shown;
}

function decideLaunch(toolInput, table, context = {}) {
  if (!table || table.ok !== true) return { findings: [tableInvalidFinding(table)], override: null };
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  const hdr = parseBriefHeader(typeof ti.prompt === "string" ? ti.prompt : "");
  if (hdr.role === null) {
    const trace = context.launch_diagnostics;
    const source = trace?.runtime_source ?? {
      path: ".claude/hooks/lib/effort-routing.js",
      sha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    };
    const diagnostic = launchDiagnostic({
      tool_name: typeof context.tool_name === "string" ? context.tool_name : "UNKNOWN",
      argument_keys: launchArgumentKeys(trace?.argument_keys ?? Object.keys(ti).sort(), trace?.argument_key_count), argument_key_count: trace?.argument_key_count ?? Object.keys(ti).length,
      prompt_source_key: "prompt",
      prompt_empty: typeof ti.prompt !== "string" || ti.prompt.trim() === "",
      native_tool_name: trace?.native_tool_name ?? null,
      native_prompt_source_key: trace?.source_key ?? null, native_message: trace?.native_message ?? null, canonical_prompt: launchContentFingerprint(ti.prompt),
      runtime_source: source,
    });
    return { findings: [finding("block", hdr.roleCode || "ROLE_MISSING",
      `${hdr.roleError}. Every launch's brief MUST begin with \`ROLE: <role>\` and carry the effort that ` +
        `role maps to. ${remedyText(table, null)}\nLAUNCH_INPUT ${diagnostic}`)], override: null };
  }
  if (!own(table.roles, hdr.role)) {
    return { findings: [finding("block", "ROLE_UNKNOWN",
      `\`ROLE: ${clip(hdr.role, 60)}\` is not in the routing table. ${remedyText(table, null)}`)], override: null };
  }
  const required = table.roles[hdr.role];
  if (hdr.overrideError) {
    return { findings: [finding("block", "OVERRIDE_MALFORMED",
      `${hdr.overrideError}. Role \`${hdr.role}\` requires effort: ${required}; fix the override line or remove it. ` +
        remedyText(table, hdr.role))], override: null };
  }
  if (ti.subagent_type === FORK_SUBAGENT_TYPE) return decideForkLaunch(hdr, required, table);
  const effort = effortOf(ti);
  if (effort === null) {
    return { findings: [finding("block", "EFFORT_MISSING",
      `this launch carries no effort parameter. Role \`${hdr.role}\` requires effort: ${required}. ` +
        `If this launch surface offers no effort parameter, launch through one that does (the Agent tool, or ` +
        `Codex spawn_agent). ${remedyText(table, hdr.role)}`)], override: null };
  }
  if (hdr.override && hdr.override.level !== required) {
    if (effort !== hdr.override.level) {
      return { findings: [finding("block", "EFFORT_MISMATCH",
        `the EFFORT-OVERRIDE line names ${hdr.override.level} but this launch carries effort: ${clip(effort, 20)}. ` +
          `Set effort: ${hdr.override.level} to use the override, or drop it and use the role's effort: ${required}. ` +
          remedyText(table, hdr.role))], override: null };
    }
    const override = { role: hdr.role, required, level: hdr.override.level, reason: hdr.override.reason };
    return { findings: [finding("advisory", "OVERRIDE_HONOURED",
      `role \`${hdr.role}\` requires effort: ${required}; this launch runs at ${hdr.override.level} under ` +
        `EFFORT-OVERRIDE ("${clip(hdr.override.reason, 120)}"). The override is recorded in the override use ledger.`)], override };
  }
  if (effort !== required) {
    return { findings: [finding("block", "EFFORT_MISMATCH",
      `role \`${hdr.role}\` requires effort: ${required}; this launch carries effort: ${clip(effort, 20)}. ` +
        `Re-issue with effort: ${required}, or add the second line \`EFFORT-OVERRIDE: <level> — <reason>\`. ` +
        remedyText(table, hdr.role))], override: null };
  }
  return { findings: [], override: null };
}

/**
 * A `fork` launch. The harness runs a fork at its PARENT's effort and ignores the `effort` parameter,
 * so the routed level cannot be applied through it — passing it on a matching `effort` value would
 * record a level that never ran. Blocked (`EFFORT_INAPPLICABLE`) unless the brief's override line
 * acknowledges the deviation, in which case the override is honoured and RECORDED like any other —
 * so every fork's effort deviation leaves a ledger row. The `effort` parameter is not read here.
 */
function decideForkLaunch(hdr, required, table) {
  if (!hdr.override) {
    return { findings: [finding("block", "EFFORT_INAPPLICABLE",
      `a \`fork\` runs at its parent's effort and ignores the effort parameter, so role \`${hdr.role}\` ` +
        `(effort: ${required}) cannot be routed through one. Launch a non-fork subagent with effort: ${required}, ` +
        `or make the second line \`EFFORT-OVERRIDE: <level> — <reason>\` naming the level the parent runs at; ` +
        `the override is recorded. ${remedyText(table, hdr.role)}`)], override: null };
  }
  const override = { role: hdr.role, required, level: hdr.override.level, reason: hdr.override.reason, fork: true };
  return { findings: [finding("advisory", "OVERRIDE_HONOURED",
    `role \`${hdr.role}\` requires effort: ${required}; this \`fork\` runs at its parent's effort (declared ` +
      `${hdr.override.level}) under EFFORT-OVERRIDE ("${clip(hdr.override.reason, 120)}"). The override is recorded ` +
      `in the override use ledger.`)], override };
}

/** The recipient of a follow-up: Claude `to`, the Codex projection `recipient`. Ambiguous ⇒ null. */
function recipientOf(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  const vals = [ti.to, ti.recipient].filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  if (vals.length === 0) return null;
  return vals.every((v) => v === vals[0]) ? vals[0] : null;
}

/** The follow-up's text: Claude `message` (string), the Codex projection `content`. */
function messageOf(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (typeof ti.message === "string") return ti.message;
  if (typeof ti.content === "string") return ti.content;
  return "";
}

/** True when a follow-up DECLARES a role — the only follow-ups the re-tasking check reads. */
function declaresRole(toolInput) {
  const text = messageOf(toolInput);
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  return typeof first === "string" && first.startsWith("ROLE:");
}

/**
 * The effort an agent was LAUNCHED with, from dispatch-ledger rows. Pure.
 *
 * Scoped to launch rows of the SENDER's generation with that dispatch name (a name is unique within a
 * generation — it is the SendMessage address — but not across generations). The ledger producer runs
 * BEFORE the guard, so a launch the routing gate went on to BLOCK is recorded too; the producer tags
 * each row `effort_routed` with the routing verdict the guard would reach (`emit-dispatch-ledger.js`).
 * When any matching row is tagged `effort_routed: true`, only those rows are read — so a blocked
 * launch followed by its corrected retry resolves to the retry. Every row read must carry the same
 * recorded level; rows that still disagree are UNKNOWN rather than a guess at which one ran.
 *
 * @returns {{state:"known", effort:string} | {state:"unknown", reason:string}}
 */
function launchEffortFor(rows, recipient, generation) {
  if (!Array.isArray(rows)) return { state: "unknown", reason: "the dispatch ledger could not be read" };
  if (typeof recipient !== "string" || !recipient) return { state: "unknown", reason: "the follow-up names no single recipient" };
  const matches = rows.filter((r) => r && r.kind === "launch" && r.dispatch_name === recipient &&
    (typeof r.generation === "string" ? r.generation : "") === generation);
  if (matches.length === 0) return { state: "unknown", reason: `no launch of "${clip(recipient, 60)}" is recorded in this generation` };
  const routed = matches.filter((r) => r.effort_routed === true);
  const read = routed.length > 0 ? routed : matches;
  const levels = new Set(read.map((r) => (LEVELS.includes(r.effort) ? r.effort : null)));
  if (levels.has(null)) return { state: "unknown", reason: `a recorded launch of "${clip(recipient, 60)}" carries no effort` };
  if (levels.size !== 1) return { state: "unknown", reason: `recorded launches of "${clip(recipient, 60)}" disagree on effort` };
  return { state: "known", effort: [...levels][0] };
}

/**
 * Decide one RE-TASKING follow-up. Pure.
 *
 * @param {object} toolInput the SendMessage `tool_input`
 * @param {object} table a `loadRoutingTable` result
 * @param {{state:"known",effort:string}|{state:"unknown",reason:string}} launch from `launchEffortFor`
 */
function decideRetask(toolInput, table, launch) {
  if (!declaresRole(toolInput)) return { findings: [], override: null };
  const named = recipientOf(toolInput);
  if (named === LEAD_RECIPIENT) return { findings: [], override: null };
  const recipient = named || "<recipient>";
  // The LAUNCH is resolved FIRST: every block below needs a known launch. With none, nothing here is
  // a re-task this module can judge, so every finding — table, role or override — is ADVISORY.
  const known = Boolean(launch && launch.state === "known");
  const sev = known ? "block" : "advisory";
  const unknownNote = known ? "" : ` (advisory only: the effort "${clip(recipient, 60)}" was launched with is unknown — ` +
    `${clip((launch && launch.reason) || "no ledger answer", 120)})`;
  // With a KNOWN launch the re-task is also correctable in place: name a role at the launch's effort.
  const sameEffort = known ? retaskInPlaceText(table, recipient, launch.effort) : "";
  if (!table || table.ok !== true) {
    const f = tableInvalidFinding(table);
    return { findings: [known ? f : { ...f, severity: "advisory", evidence: f.evidence + unknownNote }], override: null };
  }
  const hdr = parseBriefHeader(messageOf(toolInput));
  if (hdr.role === null) {
    return { findings: [finding(sev, hdr.roleCode || "ROLE_MALFORMED",
      `${hdr.roleError}. ${remedyText(table, null, true)}${sameEffort}${unknownNote}`)], override: null };
  }
  if (!own(table.roles, hdr.role)) {
    return { findings: [finding(sev, "ROLE_UNKNOWN",
      `\`ROLE: ${clip(hdr.role, 60)}\` is not in the routing table. ${remedyText(table, null, true)}${sameEffort}${unknownNote}`)], override: null };
  }
  const required = table.roles[hdr.role];
  if (hdr.overrideError) {
    return { findings: [finding(sev, "OVERRIDE_MALFORMED",
      `${hdr.overrideError}. Role \`${hdr.role}\` requires effort: ${required}. ${remedyText(table, hdr.role, true)}${sameEffort}${unknownNote}`)], override: null };
  }
  if (!known) {
    return { findings: [finding("advisory", "RETASK_LAUNCH_UNKNOWN",
      `re-tasking "${clip(recipient, 60)}" as \`${hdr.role}\` (effort: ${required}), but the effort it was launched ` +
        `with is unknown (${clip((launch && launch.reason) || "no ledger answer", 120)}). If it was not launched at ` +
        `${required}, dispatch a fresh agent at ${required} instead.`)], override: null };
  }
  if (launch.effort === required) return { findings: [], override: null };
  if (hdr.override && hdr.override.level === launch.effort) {
    const override = { role: hdr.role, required, level: launch.effort, reason: hdr.override.reason };
    return { findings: [finding("advisory", "OVERRIDE_HONOURED",
      `re-tasking "${clip(recipient, 60)}" (launched at ${launch.effort}) as \`${hdr.role}\`, which requires ` +
        `effort: ${required}, under EFFORT-OVERRIDE ("${clip(hdr.override.reason, 120)}"). Recorded in the override use ledger.`)], override };
  }
  return { findings: [finding("block", "RETASK_EFFORT_MISMATCH",
    `"${clip(recipient, 60)}" was launched at effort: ${launch.effort}, and role \`${hdr.role}\` requires effort: ` +
      `${required}. A running agent's effort cannot be changed by a message — dispatch a fresh agent at ${required} ` +
      `with \`ROLE: ${hdr.role}\` instead of re-tasking this one. ${remedyText(table, hdr.role, true)}${sameEffort}`)], override: null };
}

/**
 * The in-place alternative for a re-task against a KNOWN launch: the roles whose effort equals the one
 * the recipient was launched with, each as its exact first line. Empty when the table has none.
 */
function retaskInPlaceText(table, recipient, effort) {
  if (!table || !table.ok || !LEVELS.includes(effort)) return "";
  const lines = Object.entries(table.roles).filter(([, l]) => l === effort).map(([r]) => `\`ROLE: ${r}\``);
  if (lines.length === 0) return "";
  return ` To re-task "${clip(recipient, 60)}" in place instead, the follow-up's FIRST line must name a role at the ` +
    `effort it was launched with (${effort}): ${lines.join(", ")}.`;
}

/** The remedy for a Workflow agent() this check cannot read literally (root ruling 2026-10-12). */
const LITERAL_REMEDY = "make the ROLE line and the effort literal in this agent() call — a literal prompt beginning " +
  "`ROLE: <role>` and a literal `effort` option — or inline the script (`script`) / pass it as an absolute, " +
  "readable `scriptPath`";

/** The remedy for a launch hook this check cannot PROVE is a direct call (E3 R2 security). */
const DIRECT_REMEDY = "call `agent(...)` directly — the identifier `agent` immediately followed by `(`, with a literal " +
  "prompt beginning `ROLE: <role>` and a literal `effort` option — and never alias, map, wrap, index, escape, compute " +
  "or reflect it (no `eval`, `Function`, `constructor`, `globalThis`, `this`); inline a child workflow's agent() calls " +
  "rather than calling `workflow(...)`";

/**
 * Decide one WORKFLOW launch (finding ROOT-W1). Pure: the caller resolves and scans the script
 * (`lib/workflow-launch-scan.js`) and passes both results here.
 *
 * Each `agent(` call whose prompt and effort are both literal is judged exactly as a launch
 * (`decideLaunch`) and BLOCKS the Workflow call on the same faults, each finding naming the call's
 * line. FAIL-CLOSED on everything this lexical reading cannot evaluate (root ruling 2026-10-12,
 * matching the Epic 3 contract's C-11): a non-literal prompt or effort, an override line that could
 * arrive through a substitution, a nested `workflow(` call, every use of a launch hook the scanner
 * could not prove is a direct call (`scan.indirect`, E3 R2 security), and a script it cannot resolve,
 * read or tokenize each BLOCK, with the self-correction — make the ROLE line and the effort literal, or inline
 * the script — plus the role list and, where the role is known, the required effort. An agent whose
 * ROLE and effort cannot be read is an agent this gate cannot route, which is the launch the gate
 * exists to stop.
 *
 * @returns {{findings:object[], overrides:object[], summary:{agents_found:number|null, unresolved:number|null}}}
 */
function decideWorkflowLaunch(resolved, scan, table) {
  const findings = [];
  const overrides = [];
  if (!resolved || resolved.ok !== true) {
    // "non-symlinked" below is what the remedy ASKS for; what is ENFORCED is narrower: the scanner's
    // `O_NOFOLLOW` refuses a symlink only in the FINAL component (a symlinked parent is followed), and
    // no declared root fences a `scriptPath` (`lib/workflow-launch-scan.js::readScriptFile`).
    findings.push(finding("block", "WORKFLOW_UNRESOLVED",
      `this Workflow's script could not be read (${clip((resolved && resolved.reason) || "unknown", 200)}), so the ` +
        `ROLE and effort of its agent() launches cannot be checked — fail-closed. SELF-CORRECT: pass exactly one ` +
        `source — inline the script (\`script\`) or give it as an absolute, readable, non-symlinked \`scriptPath\` — with each agent() call carrying a ` +
        `literal prompt beginning \`ROLE: <role>\` and a literal \`effort\`. ${remedyText(table, null)}`));
    return { findings, overrides, summary: { agents_found: null, unresolved: null } };
  }
  if (!scan || scan.ok !== true) {
    findings.push(finding("block", "WORKFLOW_UNRESOLVED",
      `this Workflow's script could not be scanned (${clip((scan && scan.reason) || "unknown", 160)}), so the ` +
        `ROLE and effort of its agent() launches cannot be checked — fail-closed. SELF-CORRECT: ${LITERAL_REMEDY}. ` +
        remedyText(table, null)));
    return { findings, overrides, summary: { agents_found: null, unresolved: null } };
  }
  let unresolved = 0;
  const indirect = Array.isArray(scan.indirect) ? scan.indirect : [];
  const indirectMore = Number.isInteger(scan.indirectMore) ? scan.indirectMore : 0;
  if ((scan.calls.length > 0 || scan.nested.length > 0 || indirect.length > 0) && (!table || table.ok !== true)) {
    return { findings: [tableInvalidFinding(table)], overrides, summary: { agents_found: scan.calls.length, unresolved: null } };
  }
  for (const c of scan.calls) {
    const at = `Workflow agent() call at script line ${c.line}`;
    if (!c.prompt.evaluable) {
      unresolved++;
      findings.push(finding("block", "WORKFLOW_UNEVALUATED",
        `${at}: ${c.prompt.why}, so its ROLE and effort cannot be read — fail-closed. SELF-CORRECT: ${LITERAL_REMEDY} ` +
          `(a template is literal enough when its text before the first \${…} holds the whole \`ROLE:\` line). ` +
          remedyText(table, null)));
      continue;
    }
    const hdr = parseBriefHeader(c.prompt.text);
    if (!c.options.evaluable) {
      if (hdr.role === null || !own(table.roles, hdr.role)) {
        // No effort can fix a missing or unknown role: judge it with a placeholder effort.
        for (const f of decideLaunch({ prompt: c.prompt.text, effort: "medium" }, table).findings) {
          findings.push({ ...f, evidence: `${at}: ${f.evidence}` });
        }
        continue;
      }
      unresolved++;
      findings.push(finding("block", "WORKFLOW_UNEVALUATED",
        `${at}: ${c.options.why}, so its effort cannot be read — fail-closed. Role \`${hdr.role}\` requires effort: ` +
          `${table.roles[hdr.role]}. SELF-CORRECT: ${LITERAL_REMEDY}. ${remedyText(table, hdr.role)}`));
      continue;
    }
    const ti = { prompt: c.prompt.text };
    if (c.options.effort !== null) ti.effort = c.options.effort;
    if (typeof c.options.agentType === "string") ti.subagent_type = c.options.agentType;
    const r = decideLaunch(ti, table);
    const overrideHidden = c.prompt.overrideUnknown === true && hdr.role !== null && own(table.roles, hdr.role) &&
      c.options.effort !== null && c.options.effort !== table.roles[hdr.role];
    for (const f of r.findings) {
      findings.push(overrideHidden && f.code === "EFFORT_MISMATCH"
        ? { ...f, evidence: `${at}: ${f.evidence} An EFFORT-OVERRIDE line that arrives through the prompt's ` +
            `substitution cannot be read here, so it is not honoured: write the override line literally, before the ` +
            `first \${…}.` }
        : { ...f, evidence: `${at}: ${f.evidence}` });
    }
    if (r.override) overrides.push({ ...r.override, line: c.line, prompt: c.prompt.text });
  }
  // PROOF, NOT SEARCH: every occurrence of a launch hook that is not a direct call could be a launch this
  // gate never sees, so each one BLOCKS — never passes as a script with nothing to judge.
  for (const o of indirect) {
    unresolved++;
    findings.push(finding("block", "WORKFLOW_INDIRECT",
      `script line ${o.line}: ${o.why}, so the agents this script launches cannot be proven — fail-closed. ` +
        `SELF-CORRECT: ${DIRECT_REMEDY}. ${remedyText(table, null)}`));
  }
  if (indirectMore > 0) {
    unresolved += indirectMore;
    findings.push(finding("block", "WORKFLOW_INDIRECT",
      `${indirectMore} further occurrence(s) of the same kind, not listed one by one — fix every one. ` +
        `SELF-CORRECT: ${DIRECT_REMEDY}. ${remedyText(table, null)}`));
  }
  for (const n of scan.nested) {
    unresolved++;
    findings.push(finding("block", "WORKFLOW_NESTED_UNRESOLVED",
      `a nested workflow() call at script line ${n.line} runs a child script this check does not read, so its ` +
        `agent() launches cannot be checked — fail-closed. SELF-CORRECT: inline the child's agent() calls into this ` +
        `script, each with a literal \`ROLE: <role>\` first line and a literal \`effort\`. ${remedyText(table, null)}`));
  }
  return { findings, overrides, summary: { agents_found: scan.calls.length, unresolved } };
}

// ── VERIFICATION — what the lane observably did, against what it declared ───────────────────

/** Effort levels the Claude band check applies to. Below `high` no band is defined. */
const HIGH_CLASS = Object.freeze(["high", "xhigh", "max"]);

/**
 * The Claude advisory band, from the measured basis: low x3 ran 87-88k tokens with 2 tool calls;
 * high x3 ran 95-208k tokens with 5-8 calls. A high-class launch at or under BOTH bounds looks like
 * a low run — it MAY not have had its effort applied. A band, not a verdict: advisory only.
 */
const CLAUDE_BAND = Object.freeze({ maxToolCalls: 2, maxTokensExclusive: 90000 });

/** Cap on the agent-transcript read. A lane small enough to fall in the band is far below it. */
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Read a Claude AGENT transcript: the tool calls it made and the newest usage total. NEVER throws.
 * Every entry of an agent transcript is a sidechain entry, so — unlike the main-thread context
 * meter — sidechain entries are NOT skipped here.
 *
 * @returns {{ok:true, toolCalls:number, tokens:number} | {ok:false, reason:string}}
 */
function readAgentUsage(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return { ok: false, reason: "no agent transcript path" };
  let text;
  let fd = null;
  try {
    let nofollow = 0;
    try {
      nofollow = require("./transcript-read.js").transcriptOpenGuards().nofollow || 0;
    } catch {
      nofollow = 0;
    }
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | nofollow);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "the agent transcript is not a regular file" };
    if (st.size > TRANSCRIPT_MAX_BYTES) return { ok: false, reason: "the agent transcript exceeds the read cap" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    text = buf.subarray(0, off).toString("utf8");
  } catch (e) {
    return { ok: false, reason: `the agent transcript could not be read (${(e && e.code) || "error"})` };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* closing a read fd; nothing to recover */ }
    }
  }
  const toolIds = new Set();
  let anonymousTools = 0;
  let tokens = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e && e.message;
    if (!e || e.type !== "assistant" || !msg || typeof msg !== "object") continue;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === "tool_use") {
          if (typeof b.id === "string" && b.id) toolIds.add(b.id);
          else anonymousTools++;
        }
      }
    }
    const u = msg.usage;
    if (u && typeof u === "object" && typeof u.input_tokens === "number") {
      tokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
    }
  }
  if (tokens === null) return { ok: false, reason: "the agent transcript carries no usage block" };
  return { ok: true, toolCalls: toolIds.size + anonymousTools, tokens };
}

/**
 * Compare a launch's declared effort with what was observed. Pure. ADVISORY — no state blocks.
 *
 *   UNKNOWN     the inputs cannot answer (no launch effort; Codex without a native effort; no usage)
 *   NO_BAND     Claude, a level below `high`: no band is defined, so nothing was checked
 *   SUSPECT     Claude, a high-class launch inside the low-run band — effort may not have applied
 *   MISMATCH    Codex, its recorded effort differs from the declared one
 *   CONSISTENT  the observation agrees with the declaration
 *
 * @param {{launchEffort:string|null, runtime:string, usage?:object, nativeEffort?:string}} a
 * @returns {{state:string, reason:string}}
 */
function assessEffortApplication(a) {
  const x = a && typeof a === "object" ? a : {};
  const declared = LEVELS.includes(x.launchEffort) ? x.launchEffort : null;
  if (declared === null) return { state: "UNKNOWN", reason: "the launch's declared effort is unknown" };
  if (x.runtime === "codex") {
    if (typeof x.nativeEffort !== "string" || x.nativeEffort.trim() === "") {
      return { state: "UNKNOWN", reason: "the Codex payload carries no recorded effort" };
    }
    const native = x.nativeEffort.trim();
    return native === declared
      ? { state: "CONSISTENT", reason: `Codex recorded effort ${native}, as declared` }
      : { state: "MISMATCH", reason: `Codex recorded effort ${clip(native, 20)}, but the launch declared ${declared}` };
  }
  if (!HIGH_CLASS.includes(declared)) return { state: "NO_BAND", reason: `no band is defined for effort ${declared}` };
  const u = x.usage;
  if (!u || u.ok !== true) return { state: "UNKNOWN", reason: (u && u.reason) || "no usage observed" };
  if (u.toolCalls <= CLAUDE_BAND.maxToolCalls && u.tokens < CLAUDE_BAND.maxTokensExclusive) {
    return { state: "SUSPECT", reason: `declared ${declared}, but the lane made ${u.toolCalls} tool call(s) and used ${u.tokens} tokens — the low-effort profile` };
  }
  return { state: "CONSISTENT", reason: `declared ${declared}; ${u.toolCalls} tool call(s), ${u.tokens} tokens` };
}


/**
 * Definition: .claude/hooks/lib/effort-routing.js::launchContentFingerprint. UTF-8 hash of
 * the first non-whitespace line after splitting LF/CRLF; no other hash trimming.
 * Leading/trailing whitespace, BOM and lone CR remain. ROLE checks trim each line.
 */
function launchContentFingerprint(value) {
  if (typeof value !== "string") return null;
  const lines = value.split(/\r?\n/);
  const firstIndex = lines.findIndex(line => line.trim() !== "");
  const first = firstIndex < 0 ? undefined : lines[firstIndex];
  const roleIndex = lines.findIndex(line => line.trim().startsWith("ROLE:"));
  return {
    byte_length: Buffer.byteLength(value, "utf8"),
    leading_whitespace_count: Array.from(value.match(/^\s*/u)[0]).length,
    blank_line_count: lines.filter(line => line.trim() === "").length,
    leading_blank_line_count: firstIndex < 0 ? lines.length : firstIndex,
    first_nonempty_line_sha256: first === undefined ? null : require("node:crypto").createHash("sha256").update(first).digest("hex"),
    first_nonempty_line_starts_with_role: first !== undefined && first.trim().startsWith("ROLE:"),
    lines_before_first_role: roleIndex < 0 ? null : roleIndex,
  };
}

function launchMetadataToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "<invalid-metadata>";
}

function safeLaunchFingerprint(value) {
  if (!value || typeof value !== "object") return null;
  const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
  return {
    byte_length: count("byte_length"),
    leading_whitespace_count: count("leading_whitespace_count"),
    blank_line_count: count("blank_line_count"),
    leading_blank_line_count: count("leading_blank_line_count"),
    first_nonempty_line_sha256: typeof value.first_nonempty_line_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.first_nonempty_line_sha256) ? value.first_nonempty_line_sha256 : null,
    first_nonempty_line_starts_with_role: value.first_nonempty_line_starts_with_role === true,
    lines_before_first_role: count("lines_before_first_role"),
  };
}

function launchDiagnostic(data) {
  const source = data.runtime_source || {};
  const sourcePath = typeof source.path === "string" && /^[A-Za-z0-9_.\/-]{1,128}$/.test(source.path) &&
    !source.path.startsWith("/") && !source.path.split("/").includes("..") ? source.path : "<invalid-metadata>";
  const keys = launchArgumentKeys(data.argument_keys, data.argument_key_count);
  const total = Number.isSafeInteger(data.argument_key_count) && data.argument_key_count >= data.argument_keys.length
    ? data.argument_key_count : data.argument_keys.length;
  const diagnostic = {
    tool_name: launchMetadataToken(data.tool_name),
    argument_keys: keys,
    prompt_source_key: "prompt",
    prompt_empty: data.prompt_empty === true,
    native_tool_name: data.native_tool_name === null ? null : launchMetadataToken(data.native_tool_name),
    native_prompt_source_key: data.native_prompt_source_key === null ? null : launchMetadataToken(data.native_prompt_source_key),
    runtime_source: { path: sourcePath, sha256: typeof source.sha256 === "string" && /^[0-9a-f]{64}$/.test(source.sha256) ? source.sha256 : null },
    native_message: safeLaunchFingerprint(data.native_message),
    canonical_prompt: safeLaunchFingerprint(data.canonical_prompt),
  };
  while (JSON.stringify(diagnostic).length + "LAUNCH_INPUT ".length > 2600 && keys.length > 1) {
    if (/^\+\d+ more$/.test(keys.at(-1))) keys.pop();
    keys.pop();
    keys.push(`+${total - keys.length} more`);
  }
  return JSON.stringify(diagnostic);
}

module.exports = {
  launchArgumentKeys,
  launchContentFingerprint,
  launchDiagnostic,
  SCHEMA_VERSION,
  LEVELS,
  TABLE_PATH,
  TABLE_KEYS,
  RULE_ID,
  OVERRIDE_CHANNEL,
  LAUNCH_TOOLS,
  RETASK_TOOLS,
  WORKFLOW_TOOL,
  FORK_SUBAGENT_TYPE,
  LEAD_RECIPIENT,
  HIGH_CLASS,
  CLAUDE_BAND,
  TRANSCRIPT_MAX_BYTES,
  validateRoutingTable,
  escapedKeys,
  loadRoutingTable,
  describeRoles,
  GENERIC_ROLES,
  remedyText,
  parseBriefHeader,
  effortOf,
  decideLaunch,
  decideForkLaunch,
  recipientOf,
  messageOf,
  declaresRole,
  launchEffortFor,
  decideRetask,
  decideWorkflowLaunch,
  readAgentUsage,
  assessEffortApplication,
};
