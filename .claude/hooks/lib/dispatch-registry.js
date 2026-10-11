/**
 * dispatch-registry — the ONE place a consolidated event's detectors are listed.
 *
 * `.claude/settings.json` carries one entry per consolidated event:
 *
 *     node "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.js" <Event>
 *
 * and `.claude/hooks/dispatch-registry.json` carries, per event, the hook
 * groups that USED to sit in settings.json — same matcher, same command string,
 * same timeout. ORDER within an event is now a chosen linearization (the host ran
 * an event's hooks in parallel, so none could rely on another's order): readers
 * of trust state first (posture-gate), producers before their checkers
 * (todo-durable-guard before burndown-trace-write-guard), the file-rewriting
 * formatter last (auto-format). The registration MULTISET is unchanged.
 *
 * `expandSettingsHooks()` puts them back: given a settings object it returns a
 * copy whose dispatcher entries are replaced by the registry's groups. Every
 * tool that reasons about "which hook is registered on which event with which
 * matcher" (the delivery contract, the settings reconciler, the Codex/Gemini
 * emitters, the matcher-coherence suite, …) reads the EXPANDED view, so each of
 * them sees the registration set it always saw. `collapseSettingsHooks()` is the
 * inverse the migration uses; the pair round-trips byte-for-byte (pinned by
 * `hook-dispatch-registry.test.mjs`).
 *
 * CommonJS so both the hooks and the `.mjs` tooling can load it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY_BASENAME = "dispatch-registry.json";
// The CONSUMER-owned registration surface, `.claude/dispatch-registry.local.json`
// (sync-manifest.yaml `target_owned:`): loom never writes, overwrites or deletes
// it. It sits OUTSIDE .claude/hooks/ on purpose — that tree is a synced tier, and a
// path cannot be both shipped and target-owned. A repo registers its OWN detectors
// here and dispatch.js runs them AFTER loom's, for the events loom dispatches.
const LOCAL_REGISTRY_BASENAME = "dispatch-registry.local.json";
const localRegistryPath = (hooksDir) => path.join(hooksDir, "..", LOCAL_REGISTRY_BASENAME);
// Caps on the LOCAL registry (round-3 H1). Its content is repo-supplied and the
// dispatcher reads, parses and walks it on its own thread — where the watchdog is a
// timer that cannot fire while that thread is busy — so the work it can cause must
// be bounded by the file, never by what the file says. Both caps sit far above any
// registry a consumer writes: loom's OWN registry, every event and every guard it
// ships, is ~22 KB with at most 35 rows in one event (PreToolUse). A 1 MiB file is
// ~48× that; 512 rows in one event is ~15× loom's largest. Past either cap the file
// is refused like a malformed one (fail-closed at PreToolUse), never truncated.
const MAX_LOCAL_REGISTRY_BYTES = 1024 * 1024;
// The same cap on loom's OWN registry (round-5 LOW-1), for the same reason: it is
// read on the dispatcher's thread BEFORE any detector runs, where a runaway read
// cannot be interrupted by the watchdog. MEASURED: 21,752 B at 44000e6dd (every
// event, every guard loom ships); 1 MiB is ~48x that, so the cap is never what a
// legitimate registry meets, while a planted multi-GB file is refused after an
// fstat instead of being read. Past it the file is a read fault like a FIFO — and a
// pinned session then runs its hash-verified kept copy (resolvePinnedRegistryText).
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_LOCAL_ROWS_PER_EVENT = 512;
// "module" (default): the dispatcher requires the file and calls its `hookMain` export
// — the contract every converted loom hook satisfies. "legacy": the engine runs the file
// as its own CLI entry, in a worker thread of the dispatcher, with the process-shaped
// sandbox (stdin payload, captured stdout/stderr, process.exit / process.exitCode as the
// row's result, per-row budget; hook-engine.js § LEGACY ROWS) — for a hook written as a
// standalone stdin script, which exports no hookMain and therefore cannot be a module
// row. "process": the dispatcher spawns it as its own node process.
const DETECTOR_MODES = new Set(["module", "process", "legacy"]);
// The per-row incomplete-execution contract — `on_incomplete` on a registry row.
// "deny": the row's code path can turn the merged reply into a refusal, so the
// dispatcher runs it in a worker of its OWN (lib/hook-engine.js::runDetectorsIsolated
// § the per-row boundary) — no other row's realm can reach its verdict, and the
// engine additionally keeps per-realm-kind git-answer pools so no shared-batch
// neighbour can plant a git answer the deny row is served (round-6 SEC R1-F2;
// deny rows share that isolated pool with the OTHER DENY ROWS by design);
// AND a deny row that does NOT complete — crash, own-budget overrun, non-zero
// exit without a JSON reply — REFUSES the call at PreToolUse, fail-closed
// (lib/dispatch-main.js § FAIL-CLOSED FOR INCOMPLETE DENY ROWS; the field name
// is the contract). "continue":
// advisory; it shares a batch. MISSING or an unrecognised value reads as "deny":
// fail-closed, an unclassified row is treated as one whose verdict may refuse,
// never as one that may not (there is NO RegistryError for this field — a
// registry that cannot be READ is refused whole, but an unknown value here is a
// declaration to coerce, not a shape to reject; the authored registry's row set
// is kept explicit by .claude/bin/check-deny-capable-declarations.mjs, which reds
// both directions). The Codex policy emitter (C4 lane) reads the same
// declaration from this same registry — the field is a cross-lane interface.
const ROW_ON_INCOMPLETE_DEFAULT = "deny";
// How dispatch.js runs an event's detectors (lib/hook-engine.js::runDetectorsIsolated):
// "event" (default) one shared worker, in order; "detector" a fresh worker each, in
// order; "parallel" every detector at once, a worker each.
const ISOLATION_MODES = new Set(["event", "detector", "parallel"]);

// The host's SessionEnd wait, reproduced from Claude Code 2.1.283's `Kfe()`:
//   let n=0 … for(let g of s)for(let h of g.hooks)if(h.timeout&&h.timeout*1000>n)n=h.timeout*1000;
//   return Math.max(ygo,Math.min(n,ARo))            // ygo=1500, ARo=60000
// i.e. ALL SessionEnd hooks together get max(1.5 s, min(largest declared timeout,
// 60 s)); a hook WITHOUT a timeout contributes nothing. CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
// replaces the whole computation (and is the per-hook default, 1500 ms, otherwise).
const SESSIONEND_MIN_WAIT_MS = 1500;
const SESSIONEND_MAX_WAIT_MS = 60000;
const SESSIONEND_ENV = "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS";

/** The host's total SessionEnd wait (ms) for a settings.json `hooks.SessionEnd` group list. */
function hostSessionEndWaitMs(groups) {
  let n = 0;
  for (const g of groups || []) {
    for (const h of (g && g.hooks) || []) {
      if (h && h.timeout && h.timeout * 1000 > n) n = h.timeout * 1000;
    }
  }
  return Math.max(SESSIONEND_MIN_WAIT_MS, Math.min(n, SESSIONEND_MAX_WAIT_MS));
}
const DISPATCHER_BASENAME = "dispatch.js";
const SCHEMA = 1;

// The canonical registration form every group command in the registry MUST
// use — the dispatcher derives the file it loads from it, so a looser form
// would be a path it could be tricked into resolving outside .claude/hooks/.
const HOOK_COMMAND_RE = /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/([A-Za-z0-9][A-Za-z0-9._-]*\.js)"$/;
// `--registry-sha256=<hex>` PINS the registry the entry stands for. Claude Code
// snapshots settings.json hook commands at session start, so a mid-session edit
// of a settings hook entry never took effect silently; pinning the registry's
// content hash in that snapshotted command gives the registry the same property
// (dispatch.js runs the pinned registry, not whatever is on disk now).
const DISPATCH_COMMAND_RE = /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/dispatch\.js" ([A-Za-z]+)(?: --registry-sha256=([0-9a-f]{64}))?$/;

function dispatchCommand(event, sha256) {
  return `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${DISPATCHER_BASENAME}" ${event}${sha256 ? ` --registry-sha256=${sha256}` : ""}`;
}

/** The registry content hash a dispatcher command pins, or null. */
function dispatchPin(command) {
  const m = typeof command === "string" ? command.match(DISPATCH_COMMAND_RE) : null;
  return m && m[2] ? m[2] : null;
}

function sha256Hex(text) {
  return require("crypto").createHash("sha256").update(text).digest("hex");
}

/** The event a settings command dispatches, or null when it is not a dispatcher entry. */
function dispatchedEvent(command) {
  const m = typeof command === "string" ? command.match(DISPATCH_COMMAND_RE) : null;
  return m ? m[1] : null;
}

/** The hook basename a canonical registration command names, or null. */
function hookBasename(command) {
  const m = typeof command === "string" ? command.match(HOOK_COMMAND_RE) : null;
  return m ? m[1] : null;
}

class RegistryError extends Error {
  constructor(msg) {
    super(`dispatch-registry: ${msg}`);
    this.name = "RegistryError";
  }
}

/**
 * Validate a parsed registry. THROWS RegistryError on any shape the dispatcher
 * could misread — a registry it cannot trust is refused, never half-used.
 */
function validateRegistry(reg) {
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new RegistryError("not an object");
  if (reg.schema !== SCHEMA) throw new RegistryError(`schema must be ${SCHEMA}, got ${JSON.stringify(reg.schema)}`);
  if (!reg.events || typeof reg.events !== "object" || Array.isArray(reg.events)) {
    throw new RegistryError("`events` must be an object");
  }
  if (reg.loom_only !== undefined) {
    if (!Array.isArray(reg.loom_only) || !reg.loom_only.every((h) => typeof h === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(h))) {
      throw new RegistryError("`loom_only` must be an array of hook basenames");
    }
  }
  for (const [event, spec] of Object.entries(reg.events)) {
    if (!/^[A-Za-z]+$/.test(event)) throw new RegistryError(`bad event name ${JSON.stringify(event)}`);
    if (!spec || typeof spec !== "object") throw new RegistryError(`${event}: not an object`);
    const d = spec.dispatcher;
    if (!d || typeof d !== "object") throw new RegistryError(`${event}: missing dispatcher`);
    if (d.matcher !== undefined && typeof d.matcher !== "string") throw new RegistryError(`${event}: dispatcher.matcher must be a string`);
    if (d.isolation !== undefined && !ISOLATION_MODES.has(d.isolation)) {
      throw new RegistryError(`${event}: dispatcher.isolation must be "event", "detector" or "parallel"`);
    }
    // ≥ 5: the dispatcher keeps a 2 s reserve before the host's kill, so a smaller
    // timeout would leave a zero budget and silently skip every detector.
    if (!Number.isInteger(d.timeout) || d.timeout < 5 || d.timeout > 600) {
      throw new RegistryError(`${event}: dispatcher.timeout must be an integer 5..600`);
    }
    validateGroups(event, spec.groups, { allowMode: false });
  }
  return reg;
}

/**
 * The group list of one event — the settings.json group shape. `allowMode`
 * admits the per-hook `mode` field the LOCAL registry may carry: "module" (the
 * default — runs in-process, the hook must export hookMain), "legacy" (runs
 * in-process as the CLI script it is: the engine loads the file the way `node
 * <file>` does, so a hook that exports no hookMain still runs inside the
 * dispatcher's worker instead of costing a process; hook-engine.js § LEGACY ROWS),
 * or "process" (the dispatcher spawns it as its own node process, outside the
 * dispatcher's process tree, for a repo hook whose isolation requirement the
 * worker-thread path does not meet; it keeps its exact standalone semantics and
 * costs one process).
 */
function validateGroups(event, groups, { allowMode }) {
    if (!Array.isArray(groups) || groups.length === 0) throw new RegistryError(`${event}: groups must be a non-empty array`);
    for (const [gi, g] of groups.entries()) {
      if (!g || typeof g !== "object") throw new RegistryError(`${event}[${gi}]: not an object`);
      if (g.matcher !== undefined && typeof g.matcher !== "string") throw new RegistryError(`${event}[${gi}]: matcher must be a string`);
      if (!Array.isArray(g.hooks) || g.hooks.length === 0) throw new RegistryError(`${event}[${gi}]: hooks must be a non-empty array`);
      for (const [hi, h] of g.hooks.entries()) {
        if (!h || h.type !== "command") throw new RegistryError(`${event}[${gi}].hooks[${hi}]: type must be "command"`);
        if (!hookBasename(h.command)) {
          throw new RegistryError(`${event}[${gi}].hooks[${hi}]: command is not the canonical form: ${JSON.stringify(h.command)}`);
        }
        if (hookBasename(h.command) === DISPATCHER_BASENAME) throw new RegistryError(`${event}: the dispatcher cannot dispatch itself`);
        if (h.timeout !== undefined && (!Number.isInteger(h.timeout) || h.timeout < 1 || h.timeout > 600)) {
          throw new RegistryError(`${event}[${gi}].hooks[${hi}]: timeout must be an integer 1..600`);
        }
        if (h.mode !== undefined && (!allowMode || !DETECTOR_MODES.has(h.mode))) {
          throw new RegistryError(`${event}[${gi}].hooks[${hi}]: mode ${JSON.stringify(h.mode)} is not allowed here`);
        }
      }
    }
}

/** Validate the consumer-owned local registry (no dispatcher block; `mode` allowed). */
function validateLocalRegistry(reg) {
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new RegistryError("local: not an object");
  if (reg.schema !== SCHEMA) throw new RegistryError(`local: schema must be ${SCHEMA}, got ${JSON.stringify(reg.schema)}`);
  if (!reg.events || typeof reg.events !== "object" || Array.isArray(reg.events)) throw new RegistryError("local: `events` must be an object");
  for (const [event, spec] of Object.entries(reg.events)) {
    if (!/^[A-Za-z]+$/.test(event)) throw new RegistryError(`local: bad event name ${JSON.stringify(event)}`);
    if (!spec || typeof spec !== "object") throw new RegistryError(`local ${event}: not an object`);
    if (spec.dispatcher !== undefined) throw new RegistryError(`local ${event}: the dispatcher block is loom's; a local registry only adds groups`);
    // Counted BEFORE the per-hook walk: the row cap bounds that walk too.
    if (Array.isArray(spec.groups)) {
      let rows = 0;
      for (const g of spec.groups) rows += g && Array.isArray(g.hooks) ? g.hooks.length : 0;
      if (rows > MAX_LOCAL_ROWS_PER_EVENT) {
        throw new RegistryError(`local ${event}: ${rows} detector rows, over the cap of ${MAX_LOCAL_ROWS_PER_EVENT} per event`);
      }
    }
    validateGroups(`local ${event}`, spec.groups, { allowMode: true });
    assertNoDivergentDuplicateRows(event, spec.groups);
  }
  return reg;
}

// The typed refusal for two rows on ONE event that name the same hook and declare
// DIFFERENT `on_incomplete` values. Divergence is an ERROR, not a tie to break: the
// two lookups that consume the declaration (registry order, and the deny-class set
// the dispatcher refuses an incomplete row from) would otherwise disagree — first
// wins in one, last in the other — and the seam is silently fail-OPEN in one order
// ([deny, continue]: the deny row RUNS, its crash refuses nothing) and
// OVER-REFUSING in the other ([continue, deny]: a row that declared no refusal
// refuses). Measured by the security round's p3 probes. Refused LOUDLY, whole file,
// in the add-only spirit: ambiguity is a state to reject, not to resolve.
const DUPLICATE_ROW_DIVERGENCE_CODE = "DUPLICATE_ROW_DIVERGENCE";

/** Throws when two rows of one event name the same hook with different normalized `on_incomplete`. */
function assertNoDivergentDuplicateRows(event, groups) {
  const seen = new Map(); // hook basename (case-folded) → { hook, declared }
  for (const g of groups) {
    for (const h of g.hooks || []) {
      const base = hookBasename(h.command);
      if (!base) continue;
      const declared = onIncompleteOf(h);
      const key = base.toLowerCase();
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { hook: base, declared });
        continue;
      }
      if (prev.declared !== declared) {
        const e = new RegistryError(
          `local ${event}: ${base} is declared TWICE with DIVERGENT on_incomplete values (${prev.hook === base ? "" : `${prev.hook} vs ${base}: `}` +
            `${JSON.stringify(prev.declared)} and ${JSON.stringify(declared)}). One hook gets one declaration — ` +
            "an incomplete deny-capable row must not be able to hide behind a duplicate that says it is advisory. " +
            "Give the rows the same on_incomplete, or rename one detector.",
        );
        e.code = DUPLICATE_ROW_DIVERGENCE_CODE;
        throw e;
      }
      // Identical declarations: left as they are. The host runs one command once per
      // event, and planLocalRows keeps the FIRST matching row per hook, so the
      // duplicates collapse to one run and no verdict is ambiguous.
    }
  }
  return null;
}

// The typed refusal a local row earns when it names a hook the TEMPLATE registry
// already dispatches for the same event — the add-only invariant of
// `.claude/rules/local/` (bin/lib/local-rules.mjs::loadLocalRules,
// LocalRulesError("add-only-violation", …)) applied to hook rows. A local row can
// never override, disable or re-class a template row; naming one is refused, not
// ignored, because an ignored row reads to its author as one that added something.
const ADD_ONLY_VIOLATION_CODE = "ADD_ONLY_VIOLATION";

/** The hook basenames the TEMPLATE registry dispatches for one event, lower-cased. */
function templateHookNames(template, event) {
  const spec = template && template.events && template.events[event];
  const out = new Set();
  for (const g of (spec && spec.groups) || []) {
    for (const h of g.hooks || []) {
      const b = hookBasename(h.command);
      if (b) out.add(b.toLowerCase());
    }
  }
  return out;
}

/**
 * ADD-ONLY. Throws a TYPED refusal (RegistryError with
 * `code === ADD_ONLY_VIOLATION`) when a local row names a hook the template
 * registry already dispatches FOR THE SAME EVENT. Decided at LOAD, like the
 * local-rules precedent, so a collision is refused whether or not the call in
 * hand matches either row's matcher — a row that shadows only sometimes is
 * exactly the shape that cannot be reasoned about.
 *
 * Case-folded (macOS filesystems are case-insensitive, so `Posture-Gate.js` and
 * `posture-gate.js` are one file there), matching the precedent. A local row for
 * an event the template registry does not carry is NOT a collision — the local
 * group for such an event never runs at all (withLocal), which is a separate gap
 * this check does not own.
 *
 * `opts.isLive(hook)` — the SAME eligibility predicate the dispatcher runs the
 * template rows under (dispatch-registry.js::makeEligible: the script resolves
 * here and it is not `loom_only` outside loom). A template row this tree does NOT
 * run shadows nothing, and the dispatcher's rule has always been that an
 * ineligible loom row must not block the repo's own row of that name
 * (dispatch-main.js, "eligibility BEFORE de-duplication"). Without this the check
 * would refuse a file the runtime would happily run — it would be a NEW shadowing
 * of the repo's rows, by this very invariant.
 */
function assertAddOnly(local, template, opts = {}) {
  const isLive = typeof opts.isLive === "function" ? opts.isLive : () => true;
  for (const [event, spec] of Object.entries(local.events)) {
    const shadowed = templateHookNames(template, event);
    if (!shadowed.size) continue;
    for (const g of spec.groups) {
      for (const h of g.hooks) {
        const base = hookBasename(h.command);
        if (!shadowed.has(base.toLowerCase())) continue;
        if (!isLive(base)) continue;
        const e = new RegistryError(
          `local ${event}: row for ${base} COLLIDES with a detector .claude/hooks/dispatch-registry.json already dispatches for ${event}. ` +
            "The repo-local registry is ADD-ONLY — a local row MUST NOT override, disable or re-class a loom row. " +
            "Rename the repo's detector (and the file it names), or contribute the change to loom via /codify.",
        );
        e.code = ADD_ONLY_VIOLATION_CODE;
        throw e;
      }
    }
  }
  return local;
}

/** Whether a local registry is present at all (lstat only — its content is not read). */
function localRegistryPresent(hooksDir) {
  const p = localRegistryPath(hooksDir);
  return fs.existsSync(p) || isLink(p);
}

/**
 * The consumer's local registry, or null when absent. Throws RegistryError when
 * malformed or over MAX_LOCAL_REGISTRY_BYTES (fstat-checked before any byte is
 * read, and the read itself stops one byte past the cap — a file that grows while
 * it is read is refused too). When `template` is passed, the ADD-ONLY check runs
 * too (assertAddOnly) — the dispatcher passes it; the settings-expansion tooling,
 * which only reads, stays able to inspect a tree this check would refuse.
 */
function loadLocalRegistryIfPresent(hooksDir, template = null) {
  const p = localRegistryPath(hooksDir);
  if (!localRegistryPresent(hooksDir)) return null;
  const reg = parseLocalRegistryText(readRegularFileSync(p, MAX_LOCAL_REGISTRY_BYTES));
  if (template) assertAddOnly(reg, template);
  return reg;
}

/** Parse + validate one local registry's text. Throws RegistryError. */
function parseLocalRegistryText(text) {
  let reg;
  try {
    reg = JSON.parse(text);
  } catch (e) {
    throw new RegistryError(`local: unparseable JSON: ${e.message}`);
  }
  return validateLocalRegistry(reg);
}

// ---------------------------------------------------------------------------
// The repo-local registry's SESSION PIN
// ---------------------------------------------------------------------------
//
// The template registry is pinned by the `--registry-sha256=` value the host
// snapshotted into settings.json at session start; the local registry has no
// settings entry to carry one, so the FIRST read of a session IS the pin: the
// text read then is kept, and every later event of that session runs THAT text
// wherever the file on disk has changed (or gone). The property is the one the
// template registry already has — the session's guard set does not change
// underneath it — and the move it denies is the one only editing can make: a row
// REMOVED (or a detector path re-pointed) after the session began.
//
// BOUNDED AND OPTIONAL, exactly like the file it pins: a session with no local
// registry writes NO pin (there is nothing to protect, and an appearing file is
// an addition — rows cannot disable anything loom runs); a pin that cannot be
// read or written is a NOTICE, never a refusal — the pin is the dispatcher's own
// bookkeeping, and losing it must not cost the repo its detectors. Only the
// registry FILE's own faults (unreadable, malformed, colliding) refuse.
const LOCAL_PIN_PREFIX = "local-registry-";
// Room for the 64-hex hash, the newline, and a short fault worth of slack: the pin
// holds the registry's own bytes verbatim, capped where the registry itself is.
const LOCAL_PIN_OVERHEAD_BYTES = 256;

/**
 * Where a session's pinned local-registry copy lives. The key is the SESSION **and
 * the registry's own absolute path**: two trees' registries are different files,
 * and a session id alone would let one tree's pin be served to another (measured
 * while building this: a probe reusing one session id across sandbox trees had the
 * first tree's pin answer the second tree's reads, reported as "changed on disk").
 * Hashing the pair keeps the name a fixed length whatever the path holds.
 */
function localRegistryPinPath(dir, sessionId, registryAbsPath) {
  return path.join(dir, `${LOCAL_PIN_PREFIX}${sha256Hex(`local-registry-session:${sessionId}\n${registryAbsPath}`)}.pin`);
}

/**
 * The pin's ANCHOR — the second file, beside the pinned text, recording which sha
 * THIS session accepted at its first read.
 *
 * WHY A SECOND FILE (the security round's finding). A pin file alone is
 * self-sufficient: `sha256(text)\ntext` verifies against itself. So a pin that was
 * DELETED mid-session read as "no pin yet" and the edited registry was pinned
 * silently (fail-open, no notice), and a pin that was REPLACED with a
 * self-consistent forgery was served verbatim, with the note blaming the live file
 * for a change the live file never made. The template registry has neither hole
 * because its pin VALUE lives in settings.json — a hash the session cannot lose —
 * and the kept copy is only ever a copy. The anchor is that hash, for the local
 * registry: written once per session beside the text, never re-derived from the pin
 * file, so a missing, changed or unreadable pin becomes a REFUSAL with its own name
 * instead of a silent re-pin.
 *
 * NAMED RESIDUAL: an adversary who can write this private directory AND remove both
 * files returns the state to "the session has not pinned yet" — that is not
 * distinguishable from a first read without state outside the directory (the
 * template pin's escape is settings.json; there is no equivalent here), and it is a
 * STRICTLY larger capability than the one the finding demonstrated (one `rm` of the
 * pin, which now refuses). The invariant this design holds: once this session has
 * ACCEPTED a registry text, no later event of it runs a different one silently.
 */
function localRegistryAnchorPath(dir, sessionId, registryAbsPath) {
  return path.join(dir, `${LOCAL_PIN_PREFIX}${sha256Hex(`local-registry-session:${sessionId}\n${registryAbsPath}`)}.anchor`);
}

/** Read a kept pin (raw `sha\n<text>`), or a fault description — never a throw. */
function readLocalPin(pinPath) {
  let raw;
  try {
    raw = readRegularFileSync(pinPath, MAX_LOCAL_REGISTRY_BYTES + LOCAL_PIN_OVERHEAD_BYTES);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, kind: "absent", problem: "it does not exist" };
    return { ok: false, kind: "file", problem: (e && e.message) || (e && e.code) || String(e) };
  }
  const nl = raw.indexOf("\n");
  const head = nl === -1 ? "" : raw.slice(0, nl);
  const text = nl === -1 ? "" : raw.slice(nl + 1);
  if (!/^[0-9a-f]{64}$/.test(head) || sha256Hex(text) !== head) {
    return { ok: false, kind: "file", problem: "its content does not match its own hash" };
  }
  return { ok: true, sha: head, text };
}

/** Read the anchor (`sha\n<registry path>`), or a fault description — never a throw. */
function readLocalAnchor(anchorPath) {
  let raw;
  try {
    raw = readRegularFileSync(anchorPath, LOCAL_PIN_OVERHEAD_BYTES);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, kind: "absent", problem: "it does not exist" };
    return { ok: false, kind: "file", problem: (e && e.message) || (e && e.code) || String(e) };
  }
  const sha = raw.split("\n", 1)[0];
  if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, kind: "file", problem: "it names no accepted registry hash" };
  return { ok: true, sha };
}

/** Write the anchor atomically (0600); never overwrite an entry that is there. */
function writeLocalAnchor(anchorPath, sha) {
  const tmp = `${anchorPath}.${process.pid}.tmp`;
  let ours = false;
  try {
    const c = fs.constants;
    const fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
    ours = true;
    try {
      fs.writeSync(fd, `${sha}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, anchorPath);
    return { ok: true, problem: null };
  } catch (e) {
    if (ours) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    return { ok: false, problem: (e && e.code) || (e && e.message) || String(e) };
  }
}

/** Write a pin atomically; never overwrite an entry that is already there. */
function writeLocalPin(pinPath, text) {
  const tmp = `${pinPath}.${process.pid}.tmp`;
  let ours = false;
  try {
    const c = fs.constants;
    const fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
    ours = true;
    try {
      fs.writeSync(fd, `${sha256Hex(text)}\n${text}`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, pinPath);
    return { ok: true, problem: null };
  } catch (e) {
    // Only a file THIS call created is removed; a planted entry fails O_EXCL or
    // O_NOFOLLOW and is left exactly where it was — the write is refused, never
    // worked around.
    if (ours) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    return { ok: false, problem: (e && e.code) || (e && e.message) || String(e) };
  }
}

/**
 * The local registry text the dispatcher must run THIS event, pinned to the
 * session's first read (`sessionId` — the payload's `session_id`).
 *
 * THE PIN IS AN ACCEPTANCE RECORD, NOT A CACHE. Once this session has accepted a
 * text, nothing else may run: the pin (the accepted text) and its anchor (the
 * accepted sha) are both required, and every way they can disagree with each other
 * or with the session's own record is a REFUSAL — never a silent re-pin of whatever
 * is on disk now, and never a note that blames a file for a change it did not make.
 *
 * @returns {{text:string|null, note:string|null, notice:string|null, pinPending:{pinPath:string,anchorPath:string,text:string}|null}}
 *   `text` null ⇒ the file is (pinned) absent: no repo-owned rows for the event.
 *   `note` ⇒ the file on disk is not what runs (it changed, or cannot be read),
 *   the session's own accepted copy is serving — true of every event while it lasts.
 *   `notice` ⇒ the pin could not be KEPT (its directory is unusable, or the writes
 *   were refused): the file on disk runs, so nothing is hidden, and the session has
 *   no pin to fall back on — a hazard, said out loud, never a refusal.
 *   `pinPending` ⇒ the session's first read of a file that needs, and has not yet
 *   been given, a pin: the caller writes it with commitLocalRegistryPin ONLY once
 *   the text it returns has PARSED and VALIDATED (and passed the add-only and
 *   duplicate checks). A pin taken from a text the loader then refuses would freeze
 *   the fault: the operator repairs the file, and every later event of the session
 *   keeps serving the unparseable copy — the trap this two-step exists to close.
 *   Measured: a repaired file still refused until the session was restarted.
 * @throws RegistryError when the LIVE file is unreadable and there is no accepted
 *   copy to serve, and when the pin state itself cannot be trusted: a pin that was
 *   established and is now absent, a pin that is not the text this session
 *   accepted, an anchor with no pin, or a pin with no anchor. The caller turns
 *   every one of these into a refusal at PreToolUse (the repair hatch admits a
 *   Read and an edit of the local registry) and a loud note elsewhere.
 */
function resolveLocalRegistryText(hooksDir, sessionId, snapshotDirOrChoice) {
  // Absolute: the pin is keyed on this path, and two spellings of one file must not
  // key two pins.
  const livePath = path.resolve(localRegistryPath(hooksDir));
  const readLive = () => {
    if (!localRegistryPresent(hooksDir)) return { text: null, problem: "it does not exist" };
    try {
      return { text: readRegularFileSync(livePath, MAX_LOCAL_REGISTRY_BYTES), problem: null };
    } catch (e) {
      if (e && e.code === "ENOENT") return { text: null, problem: "it does not exist" };
      return { text: null, problem: e && e.code === "ELOOP" ? "it is a symbolic link" : (e && e.message) || (e && e.code) || String(e) };
    }
  };
  const live = readLive();
  // No session to pin against (a payload without a usable session_id): the file is
  // read fresh on every event, exactly as before the pin existed.
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512) {
    if (live.text === null && live.problem !== "it does not exist") throw new RegistryError(`local: cannot read the local registry: ${live.problem}`);
    return { text: live.text, note: null, notice: null };
  }
  const choice = snapshotDirOrChoice && typeof snapshotDirOrChoice === "object" ? snapshotDirOrChoice : { dir: snapshotDirOrChoice, rejected: null };
  const dirProblem = snapshotDirProblem(choice.dir);
  if (dirProblem !== null) {
    // No usable directory: the pin cannot be kept at all. The live file runs and the
    // hazard is said; an unreadable one is still the fault it has always been.
    if (live.text === null && live.problem !== "it does not exist") throw new RegistryError(`local: cannot read the local registry: ${live.problem}`);
    return { text: live.text, note: null, notice: localPinUnusableNotice(dirProblem) };
  }
  const pinPath = localRegistryPinPath(choice.dir, sessionId, livePath);
  const anchorPath = localRegistryAnchorPath(choice.dir, sessionId, livePath);
  const pin = readLocalPin(pinPath);
  const anchor = readLocalAnchor(anchorPath);
  const refuse = (why) =>
    new RegistryError(
      `local: ${why} — the repo-local registry is pinned to the text this session ACCEPTED, and that record can no longer be trusted. ` +
        `Remove both \`${pinPath}\` and \`${anchorPath}\` (or restart the session) to accept the file as it is now.`,
    );
  if (anchor.ok) {
    if (!pin.ok) throw refuse(`this session's pin for .claude/${LOCAL_REGISTRY_BASENAME} is ${pin.kind === "absent" ? "GONE" : `unreadable (${pin.problem})`}`);
    if (pin.sha !== anchor.sha) throw refuse("the pin is not the text this session accepted (it was replaced)");
    // The accepted text is what runs, whenever the file on disk is not identical to it.
    if (live.problem === null && sha256Hex(live.text) === pin.sha) return { text: live.text, note: null, notice: null };
    return {
      text: pin.text,
      notice: null,
      note:
        live.problem === null
          ? `.claude/${LOCAL_REGISTRY_BASENAME} changed on disk since this session first read it; the dispatcher is running the registry this session ACCEPTED. ` +
            "Restart the session (or re-review the file) to apply the change.\n"
          : `.claude/${LOCAL_REGISTRY_BASENAME} cannot be read (${live.problem}); the dispatcher is running the registry this session ACCEPTED, so the repo's own detectors still ran. ` +
            `Restore the file (e.g. \`git checkout -- .claude/${LOCAL_REGISTRY_BASENAME}\`): a NEW session cannot start its detectors without it.\n`,
    };
  }
  if (anchor.kind === "file") throw refuse(`the session's pin ACCEPTANCE RECORD at \`${anchorPath}\` cannot be read (${anchor.problem})`);
  // No anchor: either the session's first read, or a pin nobody recorded accepting.
  if (pin.ok || pin.kind === "file") throw refuse(`a pin is present with no acceptance record for it${pin.kind === "file" ? ` (${pin.problem})` : ""}`);
  if (live.text === null && live.problem !== "it does not exist") {
    throw new RegistryError(`local: cannot read the local registry: ${live.problem}`);
  }
  return { text: live.text, note: null, notice: null, pinPending: live.text === null ? null : { pinPath, anchorPath, text: live.text } };
}

/**
 * Write the pin resolveLocalRegistryText handed back, ONCE the caller has accepted
 * the text (it parsed, validated, and passed the add-only check). A refused write is
 * a notice the caller says — never a refusal of the call.
 * @returns {{ok:boolean, problem:string|null}}
 */
function commitLocalRegistryPin(pinPending) {
  const w = writeLocalPin(pinPending.pinPath, pinPending.text);
  if (!w.ok) return { ok: false, problem: w.problem };
  // The anchor LAST, and never left half-written: a pin whose anchor is missing
  // refuses on every later event, so if the anchor cannot be written the pin is
  // taken back down rather than left to poison the session.
  const a = writeLocalAnchor(pinPending.anchorPath, sha256Hex(pinPending.text));
  if (a.ok) return { ok: true, problem: null };
  let kept = "";
  try {
    fs.unlinkSync(pinPending.pinPath);
  } catch (e2) {
    kept = `; the pin itself could not be removed either (${(e2 && e2.code) || (e2 && e2.message) || e2}), so the NEXT event will refuse until ${pinPending.pinPath} and ${pinPending.anchorPath} are removed`;
  }
  return { ok: false, problem: `its acceptance record could not be written (${a.problem}) and the pin was removed again${kept}` };
}

/** The sentence said when the pin could not be WRITTEN (its own remedy, not the directory's). */
function localPinWriteNotice(pinPath, problem) {
  return (
    `the repo-local registry's pin for this session could not be written at ${pinPath} (${problem}), so it is read fresh on every event and an edit to it takes effect mid-session. ` +
    "Free space there, or remove whatever is planted at that path — the copy is retried on every event, and this notice clears once one succeeds."
  );
}

/**
 * The sentence said when a session cannot pin its local registry because the
 * SNAPSHOT DIRECTORY is not usable (the caller's notice). The directory's remedy
 * only — a fault at the pin FILE (unreadable, forged, replaced, removed) is a
 * REFUSAL with its own message, never this sentence (the correctness round measured
 * the old wording blaming "that directory" for faults that were at the file).
 */
function localPinUnusableNotice(why) {
  return (
    `this session cannot pin .claude/${LOCAL_REGISTRY_BASENAME} (${why}), so it is read fresh on every event and an edit to it takes effect mid-session. ` +
    "Remove or fix that directory (it must be a real directory owned by you, mode 0700)."
  );
}

function registryPath(hooksDir) {
  return path.join(hooksDir, REGISTRY_BASENAME);
}

/** Read + validate. Throws RegistryError (or the fs error) on failure. */
/**
 * Read a file that MUST be a regular file, without ever blocking: opened
 * O_NONBLOCK|O_NOFOLLOW and fstat-checked, so a FIFO, device or symlink planted at a
 * registry path is a fault (refused at PreToolUse) instead of a read that hangs the
 * dispatcher until the host kills it and every verdict is lost.
 */
function readRegularFileSync(p, maxBytes) {
  const c = fs.constants;
  const fd = fs.openSync(p, c.O_RDONLY | (c.O_NONBLOCK || 0) | (c.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      const e = new RegistryError(`${path.basename(p)} is not a regular file`);
      e.code = "ENOTREG";
      throw e;
    }
    if (maxBytes !== undefined) {
      const over = (n) => new RegistryError(`${path.basename(p)} is ${n} bytes, over the cap of ${maxBytes} bytes`);
      if (st.size > maxBytes) throw over(st.size);
      // At most maxBytes + 1 bytes are ever read: the +1 detects a file that grew
      // past the cap after the fstat. The buffer starts SIZE-FITTED (fstat size + 1),
      // not cap-sized — a cap-sized Buffer.alloc zero-fills 16 MiB for VERSION on
      // every event (measured 4.82 ms vs 0.0015 ms, round-5 review) — and grows
      // (doubling, never past cap + 1) only if the file grew after the fstat, so the
      // whole file up to the cap is still read and growth past it is still refused.
      let buf = Buffer.allocUnsafe(Math.min(st.size, maxBytes) + 1);
      let n = 0;
      for (;;) {
        const k = fs.readSync(fd, buf, n, buf.length - n, null);
        if (k === 0) break;
        n += k;
        if (n === buf.length) {
          if (buf.length > maxBytes) break; // cap + 1 bytes read: over the cap
          const grown = Buffer.allocUnsafe(Math.min(buf.length * 2, maxBytes + 1));
          buf.copy(grown, 0, 0, n);
          buf = grown;
        }
      }
      if (n > maxBytes) throw over(`more than ${maxBytes}`);
      return buf.subarray(0, n).toString("utf8");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function loadRegistry(hooksDir) {
  return parseRegistryText(readRegularFileSync(registryPath(hooksDir), MAX_REGISTRY_BYTES));
}

function parseRegistryText(text) {
  let reg;
  try {
    reg = JSON.parse(text);
  } catch (e) {
    throw new RegistryError(`unparseable JSON: ${e.message}`);
  }
  return validateRegistry(reg);
}

/**
 * Whether the path is a symlink. `lstat` does not follow the FINAL component, so a
 * link whose target is gone still reports here — which is what the caller wants: a
 * link sitting at the registry path is still a link sitting there.
 *
 * ENOENT means the path is genuinely absent, and that is a plain `false`. ANY OTHER
 * error means the probe is FAULTED rather than negative, and it THROWS — the same
 * disposition the hardened reader takes for a fault at the same path. The two must
 * not disagree about one path: a repo-owned deny outranks a loom rewrite, so a local
 * registry this session cannot read is a deny it cannot honour, and running without
 * it would silently allow whatever that deny covered.
 */
function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    const why = (e && e.code) || (e && e.message) || String(e);
    throw new RegistryError(
      `local: cannot probe ${p}: ${why}. A local-registry probe that cannot answer is a ` +
        "FAULT, not an absent registry — a repo deny we cannot read is a deny we cannot " +
        "honour. Remedy: repair or remove that path, then retry.",
    );
  }
}

/**
 * Where the dispatcher keeps the content-addressed copies of pinned registries.
 * `$XDG_RUNTIME_DIR` first when it is set to an absolute path — per the XDG Base
 * Directory spec it is owned by the user, mode 0700, and never shared, so the
 * pre-creation race a shared temp dir invites does not exist there (round-6 SEC
 * LOW-1) — but ONLY when that candidate passes snapshotDirProblem: a set-but-stale
 * XDG_RUNTIME_DIR (a /run/user/<uid> removed at logout while a tmux server outlives
 * the login) falls back to a per-uid directory in os.tmpdir() instead of costing the
 * session its fallback (round-7 review LOW-1). Either way the directory is used only
 * if privateSnapshotDir accepts it.
 * @returns {{ dir: string, rejected: { dir: string, problem: string } | null }}
 *   `rejected`: the XDG candidate, when one was set and could not be used.
 */
function snapshotDirChoice(env = process.env) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  const fallback = path.join(require("os").tmpdir(), `coc-dispatch-registry-${uid}`);
  const xdg = env && typeof env.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR : "";
  if (!xdg || !path.isAbsolute(xdg)) return { dir: fallback, rejected: null };
  const candidate = path.join(xdg, "coc-dispatch-registry");
  const problem = snapshotDirProblem(candidate);
  return problem === null ? { dir: candidate, rejected: null } : { dir: fallback, rejected: { dir: candidate, problem } };
}

function defaultSnapshotDir(env = process.env) {
  return snapshotDirChoice(env).dir;
}

/**
 * Why a snapshot directory cannot be used, or null when it is PRIVATE: a real
 * directory (not a symlink), owned by this user, no group/other permissions.
 * Anything else (a shared /tmp another user pre-created) is not used — no snapshot
 * is written or read there. Contents are still hash-verified on read.
 */
function snapshotDirProblem(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
    if (st.isSymbolicLink()) return "it is a symbolic link";
    if (!st.isDirectory()) return "it is not a directory";
    if (st.uid !== uid) return `it is owned by uid ${st.uid}, not this user (${uid})`;
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return `its mode ${(st.mode & 0o777).toString(8)} lets other users in (0700 expected)`;
    return null;
  } catch (e) {
    return `it cannot be created or inspected (${(e && e.code) || (e && e.message) || e})`;
  }
}

function privateSnapshotDir(dir) {
  return snapshotDirProblem(dir) === null ? dir : null;
}

/**
 * The registry text the dispatcher must run for a (possibly) pinned command.
 *
 * Unpinned → the file on disk (any read fault throws: there is nothing else to run).
 *
 * Pinned → the registry whose hash IS the pin, from wherever it can be had:
 *   - the file on disk matches → the file (and a content-addressed copy is kept so a
 *     later mid-session change can still be served the pinned version);
 *   - the file CANNOT BE READ — deleted, a symlink, a FIFO/device/directory, over
 *     MAX_REGISTRY_BYTES, unreadable — or has CHANGED → the kept copy whose hash is
 *     the pin (it cannot be forged without a SHA-256 preimage), plus a note naming
 *     what is wrong with the file on disk (round-5 MEDIUM-1: before, a read fault
 *     threw BEFORE the kept copy was consulted, so `rm dispatch-registry.json`
 *     mid-session switched every loom detector off at every event but PreToolUse);
 *   - no such copy → RegistryError naming the on-disk problem (the caller refuses
 *     at PreToolUse, fails open loudly elsewhere).
 * `snapshotDir`: a directory, or a snapshotDirChoice() result (whose `rejected` XDG
 * candidate is then named in the remedy instead of advising to set XDG_RUNTIME_DIR).
 * @returns {{ text: string, note: string|null, notice: string|null, noticeEveryEvent: boolean }}
 *   `note`: the file on disk is not what runs (a kept copy is serving) — true of
 *   every event while it lasts. `notice`: the session has NO kept copy to fall back
 *   on — the snapshot directory is unusable, OR the copy could not be written or
 *   could not be placed — a hazard, not a fault: every detector ran; the caller
 *   decides where saying so is actionable. `noticeEveryEvent` says which of those it
 *   is: the write/placement condition is RE-TRIED on every event, so the caller says
 *   it on every event and it clears itself the moment one retry succeeds. The
 *   unusable-directory one is not retried in that sense (fixing it is the operator's
 *   move, and the refusal it leads to names the directory), so it stays once-per-session.
 */
function resolvePinnedRegistryText(hooksDir, pin, snapshotDirOrChoice) {
  const choice =
    snapshotDirOrChoice && typeof snapshotDirOrChoice === "object"
      ? snapshotDirOrChoice
      : { dir: snapshotDirOrChoice, rejected: null };
  const snapshotDir = choice.dir;
  if (!pin) return { text: readRegularFileSync(registryPath(hooksDir), MAX_REGISTRY_BYTES), note: null, notice: null };
  let live = null;
  let liveProblem = null;
  try {
    live = readRegularFileSync(registryPath(hooksDir), MAX_REGISTRY_BYTES);
  } catch (e) {
    liveProblem = e && e.code === "ENOENT" ? "it does not exist" : e && e.code === "ELOOP" ? "it is a symbolic link" : (e && e.message) || String(e);
  }
  const dirProblem = snapshotDirProblem(snapshotDir);
  const dir = dirProblem === null ? snapshotDir : null;
  const snap = dir ? path.join(dir, `${pin}.json`) : null;
  // Round-6 SEC LOW-1: a pinned session whose snapshot directory is unusable has NO
  // fallback if the registry is later deleted or edited — said, never silent.
  // The remedy never advises setting XDG_RUNTIME_DIR when XDG_RUNTIME_DIR is the
  // thing that failed (round-7 review LOW-1).
  const xdgAdvice = choice.rejected
    ? ` XDG_RUNTIME_DIR was tried first and is not usable either: ${choice.rejected.dir} (${choice.rejected.problem}) — ` +
      "it is stale or not yours (e.g. a terminal multiplexer outlived the login that created it); unset it or point it at your live runtime directory."
    : " Or set XDG_RUNTIME_DIR to your (private) runtime directory.";
  // The CONSEQUENCE half is ONE string, because both ways a copy is lost — a directory
  // that cannot be used, and a write that is refused — leave the session in the SAME
  // state: no kept copy. Only the reason and the remedy differ.
  const noCopyBody =
    "so this session keeps NO copy of the registry it pinned: " +
    "if .claude/hooks/dispatch-registry.json is deleted or changed mid-session, loom's detectors stop running (refused at PreToolUse). ";
  const noFallback =
    dirProblem === null
      ? null
      : `the pinned-registry snapshot directory ${snapshotDir} is not used (${dirProblem}), ` +
        noCopyBody +
        `Remove or fix that directory (it must be a real directory owned by you, mode 0700).${xdgAdvice}\n`;
  if (live !== null && sha256Hex(live) === pin) {
    // Round-8 review F4/F3: this write is the ONE thing that makes the kept copy exist,
    // so EVERY way it does not happen lands the session in exactly the state
    // `noFallback` announces, and each is announced through the SAME channel. Two ways:
    // a REFUSED write, and a write SKIPPED because an entry that is not a regular file
    // already sits at the copy path — `existsSync` is true for ANY entry type, so a
    // DIRECTORY there skipped the write while `wrote.ok` stayed true and the notice
    // stayed null. A bare `catch {}` here said nothing, so ENOSPC (or an entry planted
    // at the pid-predictable tmp path) cost a pinned session its fallback silently while
    // the directory-unusable case spoke up (zero-tolerance Rule 3: no honest failure is
    // swallowed).
    //
    // Only a REGULAR file can be the copy this call would have made: the later fallback
    // read is O_NONBLOCK|O_NOFOLLOW and fstat'd regular (readRegularFileSync), so a
    // directory, a symlink or a FIFO at that path yields NO fallback however it reads
    // here. lstat, not stat: what is AT the name is the question, not what it points to.
    let wrote = { ok: true, problem: null };
    let occupancy = null;
    let hasCopy = false;
    if (snap) {
      try {
        const st = fs.lstatSync(snap);
        hasCopy = st.isFile();
        if (!hasCopy) occupancy = st.isDirectory() ? "a directory is" : "a non-regular file is";
      } catch (e) {
        // ENOENT is the ordinary "no copy yet" case and stays quiet; anything else (a
        // permission change on the directory, a loop) is named rather than read as one.
        if (!e || e.code !== "ENOENT") occupancy = `the copy path could not be examined (${(e && e.code) || e})`;
      }
    }
    if (snap && !hasCopy && occupancy === null) {
      const tmp = `${snap}.${process.pid}.tmp`;
      let ours = false;
      try {
        const c = fs.constants;
        const fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
        ours = true;
        try {
          fs.writeSync(fd, live);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, snap);
      } catch (e) {
        // Only a file THIS call created is removed. At the open, a planted entry — or a
        // symlink, refused by O_NOFOLLOW — fails O_EXCL, so `ours` stays false and what
        // was planted is left alone: the write is refused, never worked around. A
        // failure AFTER the create would otherwise leave a pid-named remnant that
        // EEXISTs every later event of this session, turning one refused write into a
        // permanent one.
        let remnant = "";
        if (ours) {
          try {
            fs.unlinkSync(tmp);
          } catch (e2) {
            remnant = `; the partially written copy at ${tmp} could not be removed either (${(e2 && e2.code) || (e2 && e2.message) || e2})`;
          }
        }
        wrote = { ok: false, problem: `${(e && e.code) || (e && e.message) || e}${remnant}` };
      }
    }
    // ONE consequence half (noCopyBody), ONE channel; only the REASON clause differs
    // between a refused write and a skipped one, which is the point of the F3 fix.
    let writeNotice = null;
    if (!wrote.ok) {
      writeNotice =
        `the pinned-registry copy for this session could not be written under ${snapshotDir} (${wrote.problem}), ` +
        noCopyBody +
        "Free space there, or remove whatever is planted at that path — the copy is retried on every event, and this notice clears once one succeeds.\n";
    } else if (occupancy !== null) {
      writeNotice =
        `the pinned-registry copy for this session was NOT written (${occupancy} at ${snap}), ` +
        noCopyBody +
        "Remove that entry — the copy is retried on every event, and this notice clears once one succeeds.\n";
    }
    // Mutually exclusive by construction: a write attempt needs `snap`, which needs
    // `dirProblem === null`, which is exactly when `noFallback` is null. The `||` keeps
    // that a property of the return rather than of the reader's reasoning.
    return { text: live, note: null, notice: noFallback || writeNotice, noticeEveryEvent: writeNotice !== null };
  }
  let kept = null;
  let keptProblem = null;
  try {
    if (snap) kept = readRegularFileSync(snap, MAX_REGISTRY_BYTES);
  } catch (e) {
    // A copy that is PRESENT but unreadable (a directory, FIFO or symlink planted at
    // <pin>.json, or a permission change) must NOT read as a copy that is ABSENT: the
    // message below is the one place the operator can see the difference. ENOENT is the
    // ordinary "no copy was kept" case and stays quiet.
    keptProblem = e && e.code === "ENOENT" ? null : (e && e.message) || (e && e.code) || String(e);
  }
  if (kept !== null && sha256Hex(kept) === pin) {
    return {
      text: kept,
      notice: null,
      note:
        liveProblem === null
          ? ".claude/hooks/dispatch-registry.json changed on disk since this session's hook settings were loaded; " +
            "the dispatcher is running the registry the session STARTED with (pinned by content hash in settings.json). " +
            "Restart the session (or re-review hooks) to apply the change.\n"
          : `.claude/hooks/dispatch-registry.json cannot be read (${liveProblem}); ` +
            "the dispatcher is running the registry the session STARTED with (pinned by content hash in settings.json), so loom's detectors still ran. " +
            "Restore the file (e.g. `git checkout -- .claude/hooks/dispatch-registry.json`): a NEW session cannot start its detectors without it.\n",
    };
  }
  const why = dirProblem === null ? "" : ` (the snapshot directory ${snapshotDir} is not used: ${dirProblem})`;
  const keptWhy = keptProblem ? ` (a copy IS at ${snap} but cannot be read: ${keptProblem})` : "";
  throw new RegistryError(
    liveProblem === null
      ? `dispatch-registry.json no longer matches the registry this session pinned (--registry-sha256=${pin.slice(0, 12)}…) and no pinned copy is available${why}${keptWhy}`
      : `dispatch-registry.json cannot be read (${liveProblem}) and no copy of the registry this session pinned (--registry-sha256=${pin.slice(0, 12)}…) is available${why}${keptWhy}`,
  );
}

/** Registry, or null when the file does not exist (a tree with nothing consolidated). */
function loadRegistryIfPresent(hooksDir) {
  if (!fs.existsSync(registryPath(hooksDir))) return null;
  return loadRegistry(hooksDir);
}

/**
 * The row's declared incomplete-execution contract, NORMALIZED to "deny" /
 * "continue". Only the exact string "continue" reads as "continue"; every other
 * value — including the field being absent — reads as "deny" (fail-closed; see
 * ROW_ON_INCOMPLETE_DEFAULT). This is the ONE normalizer both the dispatcher
 * (lib/dispatch-main.js) and the declaration ratchet read, so the consumed value
 * and the checked value cannot drift. The dispatcher reads it for BOTH halves of
 * the contract: the per-row worker boundary (hook-engine.js) AND the refusal an
 * incomplete deny row earns at PreToolUse (dispatch-main.js § FAIL-CLOSED FOR
 * INCOMPLETE DENY ROWS).
 */
function onIncompleteOf(h) {
  return h && h.on_incomplete === "continue" ? "continue" : ROW_ON_INCOMPLETE_DEFAULT;
}

/**
 * The detectors a dispatcher runs for one event, flattened in registry order,
 * de-duplicated by hook file (the host runs an identical command once per
 * event), each carrying the matcher of the group it came from.
 */
function detectorsFor(reg, event) {
  const spec = reg && reg.events && reg.events[event];
  if (!spec) return [];
  const out = [];
  for (const g of spec.groups) {
    for (const h of g.hooks) {
      out.push({ event, matcher: g.matcher, hook: hookBasename(h.command), timeout: h.timeout, mode: h.mode || "module", onIncomplete: onIncompleteOf(h) });
    }
  }
  return out;
}

/**
 * Which REPO-OWNED rows run, in order — ONE pure function shared by dispatch.js
 * and lib/local-supervisor.js, so both derive the same detector list from the
 * same inputs. When a row's matcher is a regular expression the match is decided
 * inside the supervisor (never on the dispatcher's thread); the supervisor reports
 * the full match vector and both sides then apply this function to it.
 *
 * @param {{hook:string, exists:boolean, loomRuns:boolean}[]} rows the event's local
 *   rows in registry order; `exists`: the file is in .claude/hooks/; `loomRuns`:
 *   loom runs a detector of that name for this call (ADD-ONLY).
 * @param {boolean[]} matches per row, whether its matcher admits this call.
 * @returns {{run:number[], notes:{kind:"missing"|"shadowed", hook:string}[]}}
 *   `run`: row indexes to run; `notes`: what the agent is told. A second matching
 *   local row naming the same hook is dropped silently (one run per hook command,
 *   as the host de-duplicates identical commands).
 *
 * The `shadowed` note is the SECOND fence of ADD-ONLY: the dispatcher refuses a row
 * naming a template hook for this event at LOAD (assertAddOnly), so a row reaching
 * here with `loomRuns: true` is one a caller did not vet — it is dropped, named, and
 * never allowed to re-run or re-time a row loom already ran.
 */
function planLocalRows(rows, matches) {
  const run = [];
  const notes = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    if (matches[i] !== true) return;
    if (!r.exists) return notes.push({ kind: "missing", hook: r.hook });
    if (r.loomRuns) return notes.push({ kind: "shadowed", hook: r.hook });
    if (seen.has(r.hook)) return undefined;
    seen.add(r.hook);
    return run.push(i);
  });
  return { run, notes };
}

/**
 * Is <root> loom itself (or a fork of it)? `.claude/VERSION::type` is the
 * repo-class discriminator every lane already routes on (issue-triage-routing.md);
 * `coc-source` is loom. Unreadable ⇒ NOT loom (the fence's safe direction).
 */
function isLoomRepo(root) {
  return repoClass(root) === "loom";
}

// `.claude/VERSION` carries a CHANGELOG, so it grows: loom's own measured 57,490 B at
// e46e54997 (2026-04-15) and 370,588 B at b79c7ceb4 (2026-06-30, unchanged since; ~14 ms
// to read + parse on a loaded host). 16 MiB is ~45x that — it bounds what the dispatcher
// reads before loom's run (~0.6 s at the cap), and a VERSION past it is "unreadable"
// (loom_only guards RUN, with a note): loud, never a silent switch-off.
const MAX_VERSION_BYTES = 16 * 1024 * 1024;

/**
 * "loom" | "consumer" | "unreadable" — the last is surfaced, never silently mapped.
 * The dispatcher asks this BEFORE loom's detectors run (makeEligible), on the thread
 * whose watchdog cannot fire while it is blocked — so VERSION is read the way the
 * registries are (readRegularFileSync: O_NONBLOCK|O_NOFOLLOW, fstat'd regular file,
 * capped). A FIFO, device, symlink or oversize file there is "unreadable" at once —
 * which RUNS the loom_only detectors (the enforcement side) — never a read that
 * blocks until the host kills the dispatcher with every guard's verdict unread.
 */
function repoClass(root) {
  try {
    const v = JSON.parse(readRegularFileSync(path.join(root, ".claude", "VERSION"), MAX_VERSION_BYTES));
    // A VERSION without a real `type` (null, {}, [] …) is as unreadable as broken
    // JSON: every real consumer ships one, so it must not read as "consumer".
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.type !== "string" || !v.type) return "unreadable";
    return v.type === "coc-source" ? "loom" : "consumer";
  } catch {
    return "unreadable";
  }
}

/**
 * The predicate the dispatcher runs a registered detector under — the SAME two
 * conditions the settings reconciler used to decide whether a registration was
 * propagated to a tree at all:
 *   1. the script resolves on disk here, and
 *   2. it is not a `loom_only:` hook — unless this tree IS loom. The registry
 *      ships verbatim to every consumer, so without (2) a consumer still holding
 *      a STALE copy of a since-fenced loom-internal hook would run it
 *      (reconcile-settings-hooks.mjs::makeLoomOnlyPredicate, FENCE 1).
 * @returns {(hook:string)=>boolean}
 */
function makeEligible(root, reg) {
  const hooksDir = path.join(root, ".claude", "hooks");
  const loomOnly = new Set((reg && reg.loom_only) || []);
  const cls = loomOnly.size ? repoClass(root) : "loom";
  // An UNREADABLE VERSION: loom's own guards must not switch off silently, so the
  // loom_only rows RUN (a file that is on disk is run, the enforcement side) and the
  // dispatcher says so. A consumer always ships VERSION; one without it is broken.
  const inLoom = cls === "loom" || cls === "unreadable";
  const skippedLoomOnly = [];
  const ranLoomOnlyUnreadable = [];
  const eligible = (hook) => {
    if (!fs.existsSync(path.join(hooksDir, hook))) return false;
    if (!loomOnly.has(hook)) return true;
    if (inLoom) {
      if (cls === "unreadable") ranLoomOnlyUnreadable.push(hook);
      return true;
    }
    skippedLoomOnly.push(hook);
    return false;
  };
  eligible.repoClass = cls;
  eligible.skippedLoomOnly = skippedLoomOnly;
  eligible.ranLoomOnlyUnreadable = ranLoomOnlyUnreadable;
  return eligible;
}

/**
 * Settings with every dispatcher entry replaced by the registry groups it
 * stands for. Non-dispatcher groups are untouched. Returns a deep copy; the
 * input is not mutated. A dispatcher entry whose event the registry does not
 * carry is left as-is (it names no detectors to expand to).
 */
function expandSettingsHooks(settings, reg, opts = {}) {
  const eligible = typeof opts.eligible === "function" ? opts.eligible : null;
  const copy = JSON.parse(JSON.stringify(settings || {}));
  if (!reg || !copy.hooks || typeof copy.hooks !== "object") return copy;
  for (const [event, groups] of Object.entries(copy.hooks)) {
    if (!Array.isArray(groups)) continue;
    const next = [];
    for (const g of groups) {
      const hooks = g && Array.isArray(g.hooks) ? g.hooks : [];
      const disp = hooks.length === 1 ? dispatchedEvent(hooks[0] && hooks[0].command) : null;
      const spec = disp && reg.events[disp];
      if (disp === event && spec) {
        for (const rg of spec.groups) {
          const g2 = JSON.parse(JSON.stringify(rg));
          if (eligible) g2.hooks = g2.hooks.filter((h) => eligible(hookBasename(h.command)));
          if (g2.hooks.length) next.push(g2);
        }
      } else {
        next.push(g);
      }
    }
    copy.hooks[event] = next;
  }
  return copy;
}

/**
 * Convenience for tooling: read `<root>/.claude/settings.json` and return it
 * EXPANDED against `<root>/.claude/hooks/dispatch-registry.json` (when present).
 */
function readExpandedSettings(root, opts = {}) {
  const settingsFile = opts.settingsPath || path.join(root, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  return expandSettingsObject(settings, root, opts);
}

/**
 * Expand an already-parsed settings object that lives at <root>. By default the
 * EFFECTIVE view — only the detectors the dispatcher would actually run here
 * (`makeEligible`); `{ declared: true }` returns every registry row instead.
 * `{ includeLocal: false }` defers even reading repo-owned rows until Loom ran.
 */
function expandSettingsObject(settings, root, opts = {}) {
  const hooksDir = path.join(root, ".claude", "hooks");
  const reg = loadRegistryIfPresent(hooksDir);
  const local = opts.includeLocal === false ? null : loadLocalRegistryIfPresent(hooksDir);
  return expandSettingsHooks(settings, withLocal(reg, local), opts.declared ? {} : { eligible: makeEligible(root, reg) });
}

/**
 * loom's registry with the consumer's local groups appended per event (loom's
 * first — the order the dispatcher runs them). Only events loom dispatches: a
 * local group for an event with no dispatcher entry has nothing to run it.
 */
function withLocal(reg, local) {
  if (!reg || !local) return reg;
  const merged = JSON.parse(JSON.stringify(reg));
  for (const [event, spec] of Object.entries(local.events)) {
    if (!merged.events[event]) continue;
    merged.events[event].groups = merged.events[event].groups.concat(JSON.parse(JSON.stringify(spec.groups)));
  }
  return merged;
}

/**
 * The migration's inverse of expandSettingsHooks: move the named events' groups
 * out of `settings` into a registry and leave one dispatcher entry per event.
 * Returns { settings, registry } (both new objects).
 * @param {object} settings
 * @param {Record<string,{matcher?:string,timeout:number}>} plan event → dispatcher spec
 * @param {object|null} existing registry to extend
 */
function collapseSettingsHooks(settings, plan, existing) {
  const s = JSON.parse(JSON.stringify(settings));
  const reg = existing ? JSON.parse(JSON.stringify(existing)) : { schema: SCHEMA, events: {} };
  for (const [event, disp] of Object.entries(plan)) {
    const groups = s.hooks && s.hooks[event];
    if (!Array.isArray(groups) || groups.length === 0) throw new RegistryError(`${event}: nothing registered to collapse`);
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (!hookBasename(h.command)) throw new RegistryError(`${event}: non-canonical command ${JSON.stringify(h.command)} cannot be dispatched`);
      }
    }
    reg.events[event] = { dispatcher: { ...(disp.matcher !== undefined ? { matcher: disp.matcher } : {}), timeout: disp.timeout }, groups };
    const entry = { type: "command", command: dispatchCommand(event), timeout: disp.timeout };
    s.hooks[event] = [disp.matcher !== undefined ? { matcher: disp.matcher, hooks: [entry] } : { hooks: [entry] }];
  }
  validateRegistry(reg);
  return { settings: s, registry: reg };
}

module.exports = {
  ISOLATION_MODES,
  SESSIONEND_MIN_WAIT_MS,
  SESSIONEND_MAX_WAIT_MS,
  SESSIONEND_ENV,
  hostSessionEndWaitMs,
  REGISTRY_BASENAME,
  LOCAL_REGISTRY_BASENAME,
  localRegistryPath,
  localRegistryPresent,
  MAX_LOCAL_REGISTRY_BYTES,
  MAX_REGISTRY_BYTES,
  MAX_LOCAL_ROWS_PER_EVENT,
  ADD_ONLY_VIOLATION_CODE,
  assertAddOnly,
  templateHookNames,
  validateLocalRegistry,
  parseLocalRegistryText,
  loadLocalRegistryIfPresent,
  resolveLocalRegistryText,
  commitLocalRegistryPin,
  localPinUnusableNotice,
  localPinWriteNotice,
  localRegistryPinPath,
  localRegistryAnchorPath,
  assertNoDivergentDuplicateRows,
  DUPLICATE_ROW_DIVERGENCE_CODE,
  LOCAL_PIN_PREFIX,
  withLocal,
  DISPATCHER_BASENAME,
  SCHEMA,
  HOOK_COMMAND_RE,
  DISPATCH_COMMAND_RE,
  dispatchPin,
  sha256Hex,
  parseRegistryText,
  resolvePinnedRegistryText,
  defaultSnapshotDir,
  snapshotDirChoice,
  snapshotDirProblem,
  privateSnapshotDir,
  RegistryError,
  dispatchCommand,
  dispatchedEvent,
  hookBasename,
  validateRegistry,
  registryPath,
  loadRegistry,
  loadRegistryIfPresent,
  detectorsFor,
  onIncompleteOf,
  ROW_ON_INCOMPLETE_DEFAULT,
  planLocalRows,
  isLoomRepo,
  repoClass,
  MAX_VERSION_BYTES,
  makeEligible,
  expandSettingsHooks,
  expandSettingsObject,
  readExpandedSettings,
  collapseSettingsHooks,
};
