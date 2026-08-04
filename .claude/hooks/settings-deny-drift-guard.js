#!/usr/bin/env node
/**
 * Hook: settings-deny-drift-guard
 * @hook-event: SessionStart (lifecycle) — the subject is settings.json itself,
 *   durable repo state present BEFORE this session runs, so the check has
 *   something to read here. It is deliberately NOT `verification`: it does not
 *   inspect work this session produced (an OUT-OF-SESSION editor is the threat),
 *   and it must self-heal before the first tool call the restored deny rules are
 *   supposed to fence. `lifecycle` rather than `guard` because the class tracks
 *   WHEN the subject exists, not how protective the hook is: a `guard` is defined
 *   by the one in-flight action it refuses and needs a tool matcher naming it,
 *   which SessionStart has no axis for (hook-event-selection.md § Discrimination
 *   Test — protective intent does not change the event class).
 * Purpose: #1309 L3 — the between-session self-heal for the .claude/settings.json
 *          self-protection contract.
 *
 *   settings.json carries the file-tool `permissions.deny` guards for every
 *   trust-posture state file AND the hook registrations for the L1 edit-guard +
 *   this drift-guard. L1 (settings-deny-edit-guard.js) prevents a WITHIN-SESSION
 *   file-tool strip; L2 (STATE_PATH_RX) fences the Bash vector. This L3 hook is the
 *   between-session backstop: at every SessionStart it re-derives settings.json
 *   against the canonical protection shape and AUTO-RESTORES anything an
 *   OUT-OF-SESSION edit (an external editor) removed:
 *     - any missing CANONICAL_DENY_FLOOR entry, and
 *     - either guard's hook registration (edit-guard under a PreToolUse Edit|Write
 *       matcher; this drift-guard under SessionStart).
 *   Self-heal + advisory report (human-decided), never a block.
 *
 *   TRUST ANCHOR (redteam F2): the canonical floor is INLINED here — NOT read from
 *   the mutable reconcile-settings-deny.mjs bin — so poisoning that bin's
 *   CANONICAL_STATE_DENY cannot weaken what L3 restores. Kept in lockstep with the
 *   edit-guard's CANONICAL_DENY_FLOOR + the bin + settings.json by
 *   settings-deny-canon-parity.test.mjs.
 *
 *   BOOTSTRAP LIMIT (explicit): this hook cannot restore its OWN stripped
 *   registration (it would not run). That residual, and editing a guard's `.js`
 *   source directly, are out of #1309 runtime scope — covered at design time by the
 *   self-referential-codify redteam gate + git history.
 *
 *   FAIL-OPEN by construction (cc-artifacts.md Rule 7): a missing file, a parse
 *   error, a write error, an absent/malformed/never-closing stdin, or the timeout
 *   all resolve to { continue: true }. The report is advisory-severity
 *   (hook-output-discipline.md MUST-2), never a block.
 *   Atomic write (temp+rename) so a crash cannot truncate the contract (redteam P3.2).
 *
 *   STDIN (loom#1380): this hook DRAINS its SessionStart payload through the
 *   shared bounded reader (lib/read-stdin-bounded.js). Pre-#1380 it read stdin
 *   never, which the hook-runtime-smoke flagged. Measured consequence, stated
 *   precisely: at a REAL payload size (~160 bytes) the undrained bytes fit the
 *   64 KiB pipe buffer and are discarded at exit — there was NO EPIPE and NO
 *   stall in production; the smoke's EPIPE is an artifact of its deliberate
 *   256 KiB pad. What was actually lost is the payload itself (`source`,
 *   `session_id`, `cwd`), which is what the cross-root reporting below needs.
 *   The reader is event-driven and BOUNDED so the outer 5000ms fallback stays
 *   able to fire: the #857 incident was a BLOCKING fs.readFileSync(0) freezing
 *   the event loop, which is exactly what read-stdin-bounded.js exists to replace.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
// Canonical-command registration SSOT (redteam R4→R8), shared with the L1 edit-guard so
// L1 + L3 never drift on what counts as a genuine guard invocation. `invokesGuard` accepts
// ONLY the byte-exact canonical command; `canonicalGuardCommand(marker)` BUILDS it — L3
// restores THROUGH the same builder so the restore form is byte-identical to the accept
// form BY CONSTRUCTION (a divergence would else accumulate duplicate registrations).
const {
  invokesGuard,
  canonicalGuardCommand,
  dangerousEnvKeys,
} = require("./lib/settings-deny-guard-shape.js");
// loom#1380 — the fleet's ONE bounded, event-driven stdin reader. Fail-open on
// every non-happy path (TTY, empty, malformed JSON, open-no-EOF, oversize).
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// Trust anchor — kept in lockstep with settings-deny-edit-guard.js::CANONICAL_DENY_FLOOR
// + reconcile-settings-deny.mjs::CANONICAL_STATE_DENY + settings.json (parity-tested).
const CANONICAL_DENY_FLOOR = [
  "Edit(.claude/learning/posture.json)",
  "Edit(.claude/learning/posture.json.bak)",
  "Edit(.claude/learning/posture.json.tmp.*)",
  "Edit(.claude/learning/violations.jsonl)",
  "Edit(.claude/learning/violations.jsonl.*)",
  "Edit(.claude/learning/.initialized)",
  "Edit(.claude/learning/presence-mechanism.json)",
  "Edit(.claude/operators.roster.json)",
  "Edit(.claude/learning/coordination-log.jsonl)",
  "Edit(.claude/learning/.heartbeat-cache*)",
  "Edit(.claude/learning/.session-end-cache*)",
];

// The guard registrations L3 restores if an out-of-session edit removed them.
const CANONICAL_GUARD_HOOKS = [
  {
    event: "PreToolUse",
    matcher: "Edit|Write|NotebookEdit",
    marker: "settings-deny-edit-guard.js",
    // Derived from the shared builder → byte-identical to what invokesGuard accepts, so
    // the restored registration converges in one pass (no duplicate accumulation).
    command: canonicalGuardCommand("settings-deny-edit-guard.js"),
    timeout: 5,
    matcherCoversEditWrite: true,
  },
  {
    event: "SessionStart",
    matcher: null,
    marker: "settings-deny-drift-guard.js",
    command: canonicalGuardCommand("settings-deny-drift-guard.js"),
    timeout: 5,
    matcherCoversEditWrite: false,
  },
];

const TIMEOUT_MS = 5000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

function passthrough() {
  clearTimeout(_timeout);
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

// Collapse anything that could forge a LINE in the rendered advisory. C0 (\x00-
// \x1F) + DEL + C1 (\x80-\x9F): the C1 range matters because U+0085 (NEL) is
// category Cc and a Unicode mandatory line break (UAX #14 class BK), yet sits
// outside \x00-\x1F AND outside ECMAScript `\s` (= WhiteSpace ∪ LineTerminator),
// so neither the control class nor the \s collapse would catch it. U+2028/2029
// and U+00A0 ARE in JS `\s`, so the collapse handles those.
//
// CAP AT THE BOUNDARY TOO (loom#1380 R3-A). The first cut left this uncapped,
// reasoning that it runs over legitimately long AUTHORED content (the 11-entry
// deny list) and that capping untrusted PATH text was canonicalPath's job. That
// drew the asymmetry between FIELDS when the real asymmetry is PROVENANCE WITHIN
// a field: what_happened mixes the bounded canonical parts.join("; ") with two
// UNBOUNDED untrusted strings that never pass through canonicalPath —
//
//   payload.source      attacker-controlled via stdin, bounded only by
//                       read-stdin-bounded's 10 MiB MAX_STDIN_BYTES;
//   dangerousEnvStr     env key names matched by PREFIX (DYLD_/LD_/BASH_FUNC_),
//                       so the suffix is arbitrary and authored in a committed
//                       settings.json — no payload channel needed.
//
// Stripping line-forging removes FORGING, not VOLUME, so either one floods
// additionalContext, which CC ingests into the agent's context. Not injection —
// context displacement. Capping HERE rather than at the two inputs keeps the
// class closed the way the R2-4 boundary fix does; per-field caps are exactly
// the pattern that produced R2-4. 4 KiB is ~7x the 11-entry deny list, so the
// authored-content concern is satisfied with an order of magnitude to spare.
const FIELD_CAP_BYTES = 4096;

// Truncate with a VISIBLE marker: a silently-shortened advisory would be
// zero-tolerance.md Rule 3 (a fallback with no signal) one layer over — the
// operator must be able to tell a capped field from a complete one.
const capField = (t, max) =>
  t.length > max ? `${t.slice(0, max)}…[truncated ${t.length - max} chars]` : t;

const stripLineForging = (s, max = FIELD_CAP_BYTES) =>
  capField(
    String(s ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
      .trim(),
    max,
  );

// SANITIZE AT THE BOUNDARY, not per field (loom#1380 R2-4). Sanitizing the two
// fields a review named left two siblings on the same lines raw — including
// `dangerousEnvStr`, which is MORE attacker-controlled than the vector that
// motivated the fix: an env KEY authored directly in a committed settings.json,
// matched by prefix (DYLD_/LD_/BASH_FUNC_), needs no realpath fallback and no
// payload channel to reach the same rendered list. Wrapping the one place every
// advisory leaves this hook closes the class, including the next field somebody
// adds; per-field sanitization is what produced that finding.
function advisory(payload) {
  clearTimeout(_timeout);
  const { emit } = require("./lib/instruct-and-wait.js");
  // NOT `.map(stripLineForging)`: map passes (element, INDEX, array), so the
  // index would bind to the `max` parameter and truncate element N to N chars —
  // measured, it silently gutted a legitimate 1343 B advisory. Arity-safe wrapper.
  const report = Array.isArray(payload.agent_must_report)
    ? payload.agent_must_report.map((line) => stripLineForging(line))
    : payload.agent_must_report;
  emit({
    hookEvent: "SessionStart",
    severity: "advisory",
    ...payload,
    what_happened: stripLineForging(payload.what_happened),
    why: stripLineForging(payload.why),
    agent_must_report: report,
    agent_must_wait: stripLineForging(payload.agent_must_wait),
    user_summary: stripLineForging(payload.user_summary),
  });
}

function detectIndent(text) {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1].includes("\t") ? "\t" : m[1].length;
}

// `invokesGuard` (genuine-invocation predicate) is the shared SSOT required above —
// the L1 edit-guard uses the SAME helper, so both layers accept EXACTLY the same
// registrations and reject the same DEAD obfuscations (R4 F5/F7).

// The matcher tokens a mutation-scoped guard registration MUST cover — the full
// Edit|Write|NotebookEdit surface (R4 NEW-2: dropping NotebookEdit leaves a
// NotebookEdit strip of settings.json un-guarded).
const REQUIRED_MATCHER_TOKENS = ["Edit", "Write", "NotebookEdit"];
const matcherTokens = (m) =>
  (typeof m === "string" ? m : "").split("|").map((s) => s.trim());
const coversMutation = (m) => {
  const t = matcherTokens(m);
  return REQUIRED_MATCHER_TOKENS.every((tok) => t.includes(tok));
};

function isRegistered(obj, spec) {
  const groups =
    obj && obj.hooks && Array.isArray(obj.hooks[spec.event])
      ? obj.hooks[spec.event]
      : [];
  return groups.some((g) => {
    if (spec.matcherCoversEditWrite && !coversMutation(g?.matcher))
      return false;
    const hs = Array.isArray(g?.hooks) ? g.hooks : [];
    return hs.some(
      (h) => h && h.type === "command" && invokesGuard(h.command, spec.marker),
    );
  });
}

// Restore any missing CANONICAL_DENY_FLOOR entry (add-only; never reorders/drops).
function ensureDenyFloor(obj) {
  if (!obj.permissions || typeof obj.permissions !== "object")
    obj.permissions = {};
  const deny = Array.isArray(obj.permissions.deny) ? obj.permissions.deny : [];
  const present = new Set(deny);
  const missing = CANONICAL_DENY_FLOOR.filter((e) => !present.has(e));
  if (missing.length) obj.permissions.deny = [...missing, ...deny];
  else obj.permissions.deny = deny;
  return missing;
}

// Restore any missing guard registration into the correct event group.
function ensureGuardHooks(obj) {
  if (!obj.hooks || typeof obj.hooks !== "object") obj.hooks = {};
  const restored = [];
  for (const spec of CANONICAL_GUARD_HOOKS) {
    if (isRegistered(obj, spec)) continue;
    if (!Array.isArray(obj.hooks[spec.event])) obj.hooks[spec.event] = [];
    const groups = obj.hooks[spec.event];
    const entry = {
      type: "command",
      command: spec.command,
      timeout: spec.timeout,
    };
    if (spec.matcherCoversEditWrite) {
      // A group already carrying a GENUINE invocation of this marker but with a
      // NARROWED matcher (R4 NEW-2: external editor dropped NotebookEdit) — WIDEN
      // its matcher to the full mutation surface so the restore converges, rather
      // than reuse it as-is (isRegistered would stay false → non-convergent) or add
      // a duplicate.
      const withInvocation = groups.find(
        (x) =>
          Array.isArray(x?.hooks) &&
          x.hooks.some(
            (h) =>
              h && h.type === "command" && invokesGuard(h.command, spec.marker),
          ),
      );
      if (withInvocation) {
        const t = matcherTokens(withInvocation.matcher).filter(Boolean);
        for (const tok of REQUIRED_MATCHER_TOKENS)
          if (!t.includes(tok)) t.push(tok);
        withInvocation.matcher = t.join("|");
      } else {
        // No live invocation (stripped/dead) — add the canonical entry to an
        // existing full-coverage group, or create one with the canonical matcher.
        let g = groups.find((x) => coversMutation(x?.matcher));
        if (!g) {
          g = { matcher: spec.matcher, hooks: [] };
          groups.push(g);
        }
        if (!Array.isArray(g.hooks)) g.hooks = [];
        g.hooks.unshift(entry); // run the guard first
      }
    } else {
      let g = groups.find((x) => x && typeof x === "object");
      if (!g) {
        g = { hooks: [] };
        groups.push(g);
      }
      if (!Array.isArray(g.hooks)) g.hooks = [];
      g.hooks.push(entry);
    }
    restored.push(spec.marker);
  }
  return restored;
}

// F16 — MERGED sibling settings files whose `env` ALSO reaches the hook subprocess: CC merges
// the settings hierarchy (project + local + user-global), so a dangerous env key in a sibling
// redirects the guard command exactly as one in the primary would. L3 ADVISES on all three (it
// cannot self-heal env — removing an operator's key could break their setup; L1 blocks the ADD).
const MERGED_ENV_SIBLINGS = [
  {
    label: ".claude/settings.local.json",
    path: path.join(__dirname, "..", "settings.local.json"),
  },
  {
    label: "~/.claude/settings.json",
    path: path.join(os.homedir(), ".claude", "settings.json"),
  },
  {
    // Parity with L1 classifyTarget's sibling set (fail-closed — covered whether or not CC merges it).
    label: "~/.claude/settings.local.json",
    path: path.join(os.homedir(), ".claude", "settings.local.json"),
  },
];

// Dangerous env keys across the primary object + each merged sibling, as [{label, keys}].
// A missing / malformed sibling is skipped (benign — its env never applies).
function collectDangerousEnv(primaryObj) {
  const out = [];
  const pk = dangerousEnvKeys(primaryObj);
  if (pk.length) out.push({ label: ".claude/settings.json", keys: pk });
  for (const s of MERGED_ENV_SIBLINGS) {
    let raw = null;
    try {
      raw = fs.readFileSync(s.path, "utf8");
    } catch {
      continue; // sibling absent → benign
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Non-strict-JSON sibling a lenient CC parser might still accept (R12-sec-2): a lexical key
      // scan is defeatable (\uXXXX escapes, the `env`/`ENV` container-collision), so instead of
      // trusting a scan, SURFACE the sibling as unparseable — the operator verifies its env by hand.
      out.push({ label: s.label, unparseable: true });
      continue;
    }
    const k = dangerousEnvKeys(parsed);
    if (k.length) out.push({ label: s.label, keys: k });
  }
  return out;
}

const formatDangerousEnv = (report) =>
  report
    .map((r) =>
      r.unparseable
        ? `${r.label}: (non-strict-JSON — cannot verify env; check manually)`
        : `${r.label}: ${r.keys.join(", ")}`,
    )
    .join("; ");

// Resolve to the REAL canonical form. Per security.md § Path Containment, BOTH
// sides of a path comparison go through the SAME resolver before comparing; a
// realpath failure is reported as lexical rather than passed off as canonical
// (zero-tolerance.md Rule 3 — no silent fallback).
function canonicalPath(p) {
  try {
    return { path: safeText(fs.realpathSync(p)), resolved: true };
  } catch {
    return { path: safeText(path.resolve(p)), resolved: false };
  }
}

// Env- and payload-derived strings are interpolated into `agent_must_report`,
// which instruct-and-wait renders as FLAT LINES in the agent's MUST-do list. A
// newline in the source string therefore injects additional instruction lines —
// and the payoff is specifically suppressing the advisory that would expose the
// env redirect. `path.resolve` (the realpath-failure fallback) preserves
// newlines, so sanitizing at the boundary is the fix, not trusting the resolver.
// Strip control characters, collapse whitespace, and cap length.
function safeText(s, max = 200) {
  const flat = String(s)
    // Explicit \u escapes, NOT literal control bytes in the source. The first
    // attempt here pasted a literal class that silently became [\u0020-\u002D]
    // (space through hyphen): it stripped !"#$%&'()*+,- out of paths and matched
    // no control character at all. A literal control class is also unreviewable
    // in a diff, which is how that survived to a second read.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…[truncated]` : flat;
}

const lexNote = (c) => (c.resolved ? "" : " (lexical — realpath failed)");

// loom#1380 — CROSS-ROOT REPORTING (report-only; never re-targets the write).
//
// The write target is __dirname-derived ON PURPOSE and does NOT move: it is the
// same trust-anchor discipline as the inlined CANONICAL_DENY_FLOOR. The payload's
// `cwd` and CLAUDE_PROJECT_DIR are precisely the redirect vectors this guard's OWN
// F13/F16 scan flags as guard-redirecting (see dangerousEnvKeys / MERGED_ENV_SIBLINGS
// — CLAUDE_PROJECT_DIR is on that list). Choosing WHICH settings.json to protect
// from redirectable input would hand an attacker that choice, so the guard always
// heals the tree its own file lives in.
//
// Under normal CC invocation the two coincide: settings.json registers
// `node "$CLAUDE_PROJECT_DIR/.claude/hooks/settings-deny-drift-guard.js"`, so the
// copy that executes is the one inside the session's tree — including a SIBLING
// WORKTREE, which therefore heals its own settings.json correctly.
//
// They DIVERGE when something redirects the project root. The live example is
// hook-runtime-smoke.mjs, which spawns this file by absolute path from the real
// repo while setting cwd + CLAUDE_PROJECT_DIR to a throwaway sandbox: the guard
// acts on the REAL repo, defeating that probe's documented sandbox guarantee.
// Pre-#1380 that divergence was invisible — the advisory said "self-protection
// restored" without ever naming WHICH file. Now it is surfaced.
//
// @returns {null | {guardRoot: string, notes: string[]}}
function detectRootMismatch(payload, guardRootRaw) {
  const guardRoot = canonicalPath(guardRootRaw);
  const notes = [];

  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot) {
    const env = canonicalPath(envRoot);
    if (env.path !== guardRoot.path) {
      notes.push(`CLAUDE_PROJECT_DIR=${env.path}${lexNote(env)}`);
    }
  }

  // A payload `cwd` INSIDE the guard root is normal (a session started in a
  // subdirectory) — only an OUTSIDE cwd is a genuine cross-root signal.
  const rawCwd = payload && typeof payload.cwd === "string" ? payload.cwd : null;
  if (rawCwd) {
    const c = canonicalPath(rawCwd);
    const rel = path.relative(guardRoot.path, c.path);
    const outside =
      rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (outside) notes.push(`payload cwd=${c.path}${lexNote(c)}`);
  }

  if (!notes.length) return null;
  return { guardRoot: `${guardRoot.path}${lexNote(guardRoot)}`, notes };
}

const formatRootMismatch = (m, settingsPath) =>
  `NOTE: the session names a DIFFERENT project root than this guard's own location — ` +
  `${m.notes.join("; ")}, but the guard's root is ${m.guardRoot}. The guard acted on ` +
  `${settingsPath} (its own tree, by design — the write target is never taken from ` +
  `redirectable input). Verify that is the settings.json you intended to protect.`;

async function main() {
  // loom#1380 — drain the SessionStart payload. Bounded + event-driven, so the
  // module-level 5000ms fallback stays able to fire; resolves {} on absent /
  // malformed / never-closing stdin rather than throwing.
  const payload = await readStdinBounded().catch(() => ({}));
  // Report-only session context. The drift check itself is NEVER gated on the
  // payload: a security guard that skips its check based on its input is the
  // failure mode this hook exists to prevent, so every SessionStart source
  // (startup / resume / clear / compact) runs the full re-derivation.
  const source =
    payload && typeof payload.source === "string" ? payload.source : "unknown";

  const settingsPath = path.join(__dirname, "..", "settings.json");

  // loom#1380 S10 — DEFERRED ON PURPOSE. detectRootMismatch runs a SYNCHRONOUS
  // realpathSync over payload/env-derived paths; on a hung or unresponsive mount
  // that blocks the event loop, and a blocked loop cannot fire the module-level
  // 5000ms fallback — reintroducing the #857 class for a different input on the
  // same code path, which this file's own header claims the bounded reader keeps
  // closed. It is REPORT-ONLY, so nothing depends on it early. Computing it
  // lazily at advisory-construction time puts it strictly AFTER the settings read
  // and the heal, and skips it entirely on the clean-passthrough path, where the
  // guard has nothing to report and no reason to touch a foreign mount at all.
  let _mismatch;
  const rootMismatch = () => {
    if (_mismatch === undefined)
      _mismatch = detectRootMismatch(payload, path.join(__dirname, "..", ".."));
    return _mismatch;
  };
  const mismatchNote = () => {
    const m = rootMismatch();
    return m ? ` ${formatRootMismatch(m, settingsPath)}` : "";
  };

  let text;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return passthrough(); // missing (fresh/partial repo) — benign no-op
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return advisory({
      what_happened: `settings.json did not parse as JSON; the self-protection drift check could not run (${String(e.message).slice(0, 100)}). File: ${settingsPath}.${mismatchNote()}`,
      why: "settings-deny-self-protection/#1309 — a malformed settings.json cannot be drift-checked; the file-tool deny guards + the guard registrations may be absent.",
      agent_must_report: [
        `Report that settings.json is malformed and the drift check was skipped (${settingsPath})`,
        "Recommend the operator fix settings.json syntax so the protection is restorable",
      ],
      agent_must_wait:
        "No action required to proceed; surface the parse failure to the operator.",
      user_summary:
        "settings.json malformed — self-protection drift check skipped (#1309)",
    });
  }

  const restoredDeny = ensureDenyFloor(obj);
  const restoredHooks = ensureGuardHooks(obj);
  // A guard-redirecting `env` key (redteam R9 F13; R10 F16 extends the scan to the MERGED
  // siblings — settings.local.json + user-global — whose env ALSO reaches the hook subprocess)
  // neuters BOTH guards while the registration stays intact. L3 canNOT self-heal env (removing
  // an operator's env key could break their setup) — it ADVISES; L1 blocks ADDING such a key.
  const dangerousEnvReport = collectDangerousEnv(obj);
  const dangerousEnvStr = formatDangerousEnv(dangerousEnvReport);

  if (restoredDeny.length === 0 && restoredHooks.length === 0) {
    if (dangerousEnvReport.length === 0) return passthrough(); // fully clean
    // No deny/hook drift, but a guard-redirecting env key is present → advisory only (no write).
    return advisory({
      what_happened: `settings files carry guard-redirecting env key(s) — ${dangerousEnvStr}. These reach the hook subprocess (CC merges project + local + user-global settings) and can redirect how the guard command (\`node "$CLAUDE_PROJECT_DIR/.claude/hooks/..."\`) resolves at runtime, neutering the self-protection while the deny contract + registrations look intact.${mismatchNote()}`,
      why: "settings-deny-self-protection/#1309 (F13/F16; #1429; #1471 F2/F3) — a settings.json (or settings.local.json / user-global) env var can neuter a guard while its registration stays byte-identical: PATH / NODE_OPTIONS / CLAUDE_PROJECT_DIR / BASH_ENV / DYLD_* / LD_* make it execute an attacker node/module; LOOM_ECOSYSTEM_CONFIG / CLAUDE_TRUST_STATE_DIR / KAILASH_LEARNING_DIR relocate a config or root it reads; the COC_* namespace forges the operator identity it authorizes against (e.g. COC_OPERATOR_KEY_PATH pointed at any roster member's PUBLIC key); the GIT_* namespace steers the git subprocess it reaches before any identity check. L3 does not auto-remove env (it may be an intentional operator setting); this is surfaced for the operator to verify.",
      agent_must_report: [
        `Report that settings files carry guard-redirecting env key(s): ${dangerousEnvStr}`,
        "Ask the operator to confirm these env keys are intentional and safe; if not, remove them from the named settings file's `env`",
      ],
      agent_must_wait:
        "No auto-remediation applied; surface the guard-redirecting env key(s) to the operator for confirmation.",
      user_summary: `settings files have guard-redirecting env key(s) (#1309 F13/F16): ${dangerousEnvStr}`,
    });
  }

  const indent = detectIndent(text);
  let out = JSON.stringify(obj, null, indent);
  if (text.endsWith("\n")) out += "\n";
  try {
    const tmp = `${settingsPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, settingsPath);
  } catch {
    return passthrough(); // could not write — fail open
  }

  const parts = [];
  if (restoredDeny.length)
    parts.push(
      `${restoredDeny.length} deny guard(s): ${restoredDeny.join(", ")}`,
    );
  if (restoredHooks.length)
    parts.push(
      `${restoredHooks.length} guard hook registration(s): ${restoredHooks.join(", ")}`,
    );
  const envNote = dangerousEnvReport.length
    ? ` NOTE: settings files ALSO carry guard-redirecting env key(s) (${dangerousEnvStr}) — NOT auto-removed; verify they are intentional (#1309 F13/F16).`
    : "";
  const report = [
    `Report that settings.json self-protection was auto-restored at session start (file: ${settingsPath}; SessionStart source: ${source})`,
    `List what was restored: ${parts.join("; ")}`,
    "Note that an out-of-session strip of the deny contract / guard registration is a security-relevant event the operator should be aware of",
  ];
  const _rm = rootMismatch();
  if (_rm)
    report.push(
      `Surface that the session names a different project root than the file healed — ${_rm.notes.join("; ")} vs guard root ${_rm.guardRoot} — and have the operator confirm ${settingsPath} is the intended settings.json`,
    );
  if (dangerousEnvReport.length)
    report.push(
      `Also surface the guard-redirecting env key(s) present (${dangerousEnvStr}) and ask the operator to confirm they are intentional`,
    );
  return advisory({
    what_happened: `Restored settings.json self-protection at session start (file: ${settingsPath}; SessionStart source: ${source}) — ${parts.join("; ")}.${envNote}${mismatchNote()}`,
    why: "settings-deny-self-protection/#1309 — one or more elements of settings.json's self-protection (a deny guard entry, or a guard hook registration) had been removed out-of-session, leaving the trust-posture state files un-fenced. The drift-guard self-healed them from the inlined canonical anchor.",
    agent_must_report: report,
    agent_must_wait:
      "The protection is already restored; no action is required to proceed. Surface the self-heal to the operator.",
    user_summary: `restored settings.json self-protection (#1309): ${parts.join("; ")}${dangerousEnvReport.length ? " (+ guard-redirecting env key present)" : ""}`,
  });
}

main().catch(() => passthrough());
