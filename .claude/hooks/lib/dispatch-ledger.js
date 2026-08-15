"use strict";

/**
 * dispatch-ledger.js — the loom-local DISPATCH ↔ DELIVERY reconciliation stream.
 *
 * ## The gap this closes, measured
 *
 * A subagent that finishes without calling `SendMessage` delivers NOTHING: its plain text is
 * invisible to the orchestrator. The orchestrator sees "no return", cannot tell a dead lane from a
 * silent one, and re-does the work SERIALLY. That silent sequential fallback is the loss, and
 * nothing in the tree observed it:
 *
 *   - `SubagentStop` is recognized by `.claude/bin/validate-emit.mjs::HOOK_EVENTS` and was
 *     registered ZERO times.
 *   - ZERO hooks observed `SendMessage`.
 *   - The `ArtifactActivationEvent` stream records the subagent TYPE (`artifact_id`) and the
 *     LAUNCHING agent (`agent_id`). Dispatch NAMES are absent, so N same-type lanes collapse to
 *     one identity and no instrument can say WHICH lane failed to deliver.
 *   - `Stop` fires only after the main agent has already re-done the work, which is why the
 *     reconcile point is `SubagentStop`.
 *
 * ## Why a SEPARATE stream, and not a field on the activation event
 *
 * `artifact-activation-event.js` pins `activation_schema_version: 0` behind an explicit
 * PENDING-S3-RATIFICATION fence and closes its shape with `EVENT_KEYS`. Measured at both poles:
 * `buildArtifactActivationEvent({...base, launch_id: "L1"})` returns the ten canonical keys and
 * SILENTLY DROPS the extra argument, while `validateArtifactActivationEvent` rejects an extra key
 * outright. Widening it here would either lose the field or break the consumer contract, so this
 * is its own stream with its own version. It is modelled on `artifact-activation-ledger.js` and
 * inherits that module's three contracts verbatim: per-session append-only JSONL under
 * `.claude/learning/`, every write through `append-sink.js`, gitignored, NEVER throws.
 *
 * ## The record set
 *
 *   launch     one per subagent dispatch, written at PreToolUse(Task|Agent)
 *   delivery   one per SendMessage, written at PreToolUse(SendMessage)
 *   declared   one per user prompt, written at UserPromptSubmit — the DECLARED sub-part count
 *   reconcile  one per SubagentStop, written by the reconciler: its own verdict, durably
 *
 * Every record carries `generation` — THE AGENT CONTEXT THE HOOK FIRED IN, NORMALIZED to the
 * dispatch-name vocabulary (`payload.agent_id` through `normalizeAgentId`, or the `(main-agent)`
 * sentinel when absent; CC populates `agent_id` only inside a subagent, the same empirical finding
 * `emit-artifact-activation.js` records for #448). On a `launch` row that is the PARENT of the
 * dispatched lane; on a `delivery` row it is the DELIVERER itself.
 *
 * THE NORMALIZATION IS NOT COSMETIC — see `normalizeAgentId`. A runtime `agent_id` is
 * `a[<name>-]<16hex>`, NOT the bare dispatch name, so joining the raw value against
 * `dispatch_name` never matches and reports every delivering lane UNDELIVERED. That defect shipped
 * in the first cut of this module and was caught in review, not by its own tests, because the
 * fixtures used bare names on both sides of a join that production never presents that way.
 *
 * MEASURED RESIDUAL, STATED BECAUSE IT IS NOT CLOSED. The shape is measured on `agent_id` as
 * emitted for OTHER tools — 2,233 distinct values across 125,410 provenance rows plus 39 in the
 * activation sink, trailing-hex length 16 in every case, zero counterexamples. It is NOT measured
 * on a `PreToolUse:SendMessage` payload specifically: no producer observed that tool before this
 * module, and a direct search returns ZERO SendMessage rows against a control showing the same
 * query DOES fire (5 distinct tools, 3,093 `Agent` rows). This module's own producer cannot supply
 * one either, since hooks execute from `CLAUDE_PROJECT_DIR` — the main checkout — not from the
 * worktree registering them. So the delivery-side shape is an INFERENCE from the same field, same
 * producer and same event, not an observation. It is labelled as such rather than asserted.
 *
 * That residual is what the orphan fail-safe in `reconcile` exists for: if the delivery-side shape
 * ever differs, the join produces orphans, and the verdict degrades to UNRESOLVED naming them
 * instead of accusing every lane. The inference being wrong costs a stated unknown, not a false
 * accusation.
 *
 * ## Why `generation` is load-bearing and not decoration
 *
 * Hooks fire INSIDE subagent context, so a NESTED dispatch writes its rows under the subagent's
 * own id. `attributableGenerations` therefore resolves a deliverer's name to the SET of
 * generations in which a lane of that name was launched, and refuses to attribute when that set
 * has more than one member. Dispatch names are unique WITHIN a generation — the name IS the
 * `SendMessage` address, so two live same-named lanes would be unaddressable — but NOT across
 * generations: a parent and a nested lane may both launch a `reviewer`. Collapse the generation
 * field and that set has ONE member, the nested lane's delivery is attributed to the parent's
 * same-named launch, and a parent lane that delivered nothing is reported DELIVERED. That is
 * fail-open, and it is exactly the class this module exists to close.
 *
 * KNOWN RESIDUAL, stated rather than hidden: two launches with the SAME (generation, name) are
 * treated as one lane, because within a generation that is what re-recording a retried dispatch
 * looks like. A generation that dispatches `reviewer`, lets it finish, and dispatches `reviewer`
 * AGAIN is therefore satisfied by a single delivery. Distinguishing them needs a lane identity the
 * hook payload does not carry.
 *
 * ## Tri-state, never a boolean
 *
 * The ledger is gitignored, so on a fresh clone, in CI, or in any session whose launch hook never
 * ran it is ABSENT. Reporting "0 undelivered" from a missing ledger is a non-discriminating
 * instrument (`instrument-discipline.md` MUST-1): the output would be identical whether every lane
 * delivered or none did. `readLedger` therefore returns a typed failure and `reconcile` reports
 * `UNRESOLVED` with a reason, exactly as `open-pr-surface.js::formatOpenPrBlock` reports "NOT
 * verified this session" rather than "0 open PRs".
 *
 * BEST-EFFORT / NEVER-THROWS. Every helper returns a result object. A capture or reconcile failure
 * degrades observability; it NEVER blocks a session (`hook-output-discipline.md`: an observability
 * hook fails open).
 *
 * Origin: T1, runtime-enforcement-2026-08-14.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The ONE hardened append primitive (loom#1349) — six defenses, symlink/hardlink/FIFO refusal,
// 0o600. A direct `fs.appendFileSync` here would be a second, un-hardened sink.
const { appendSinkLine } = require("./append-sink.js");

/**
 * Stream version. Independent of `activation_schema_version` and deliberately NOT pinned to 0:
 * this stream has no external consumer and no pending ratification, so it is a live v1 loom-local
 * contract rather than a proposal.
 */
const LEDGER_SCHEMA_VERSION = 1;

/**
 * The main agent's generation sentinel. NOT the literal string "main": an agent may legitimately
 * be NAMED `main` (this repo's own team roster contains one), and a sentinel that collides with a
 * real dispatch name would let a main-agent delivery satisfy that lane. The parentheses cannot
 * appear in a dispatch name — the delegation tool's `name` is `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
 */
const MAIN_GENERATION = "(main-agent)";

/** Closed record vocabulary. An unrecognized `kind` is ignored by the reader, never guessed at. */
const RECORD_KINDS = Object.freeze(["launch", "delivery", "declared", "reconcile"]);

/** Reconcile verdict states. Three, never two — see the tri-state note in the header. */
const RECONCILE_STATES = Object.freeze(["RESOLVED", "UNRESOLVED"]);

/**
 * Cross-CLI delegation tool vocabulary. Kept identical to
 * `emit-artifact-activation.js::DELEGATION_TOOLS` — CC names the tool `Agent` (current harness) or
 * `Task` (vanilla alias). Widening one without the other would land the new tool silently
 * unobserved, so the registration test pins both against settings.json.
 */
const DELEGATION_TOOLS = Object.freeze(["Task", "Agent"]);
/** The teammate-messaging tool. THE delivery signal — a lane that never calls it delivered nothing. */
const DELIVERY_TOOLS = Object.freeze(["SendMessage"]);

/** Hard cap on a ledger read. A runaway sink must not turn a shutdown hook into an OOM. */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
/** Hard cap on how many undelivered lanes an advisory names, so one line cannot flood a transcript. */
const MAX_REPORTED_LANES = 12;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * Per-session sink file. Injective `session_id` → filename mapping (sanitized token + 8-char
 * sha256 of the RAW id), identical to `artifact-activation-ledger.js::_sinkPath`: two raw ids that
 * sanitize to the same token still land on distinct files, and the charclass strips every path
 * separator so a crafted session id cannot traverse out of the sink dir.
 *
 * ONE fallback for the no-session case, applied here and nowhere else — the two-doors defect that
 * bit loom#1500-L3 (a read through one door and a write through the other silently missing each
 * other) is avoided by never normalizing an absent session anywhere but this function.
 */
function _sinkPath(repoDir, session) {
  const raw = _isNonEmptyString(session) && session.trim().length > 0 ? session : "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  const suffix = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return path.join(repoDir, ".claude", "learning", "dispatch-reconcile", `${safe}-${suffix}.jsonl`);
}

/**
 * A fresh, unique launch identity.
 *
 * UNIQUENESS IS LOAD-BEARING. `reconcile` keys launches by `launch_id` to dedupe a row an
 * append-only sink may hold twice (a hook registered under two overlapping matchers writes the same
 * dispatch twice). Derive the id from the subagent TYPE instead and N same-type lanes collapse to
 * ONE map entry: the report then claims one launch where N happened and cannot name which lane
 * failed to deliver — the measured defect this stream exists to fix, reintroduced one layer down.
 */
function newLaunchId() {
  return crypto.randomBytes(9).toString("hex");
}

/**
 * The RUNTIME agent-id shape, MEASURED — not assumed.
 *
 * `payload.agent_id` is NOT the dispatch name. It is `a` + an optional `<name>-` + a 16-char hex
 * suffix. Measured against the live `.claude/learning/artifact-activation/` sink: 39 distinct
 * non-null values, 39/39 matching this pattern, 0 falsifying, with BOTH poles present —
 * `aCONV-A-correctness-2-25ba2b48182a8868` (named) and `a07ec646a2ce635bf` (unnamed).
 *
 * THIS IS THE BUG THE FIRST CUT OF THIS MODULE SHIPPED. It joined the raw `agent_id` against the
 * dispatch `name`, which can never match, so EVERY delivering lane was reported UNDELIVERED in
 * every real session — precisely the falsifying result this module names at the top ("a lane that
 * DID deliver is reported undelivered"). The instrument was sound against synthetic fixtures that
 * used bare names on both sides, and blind to the only shape that occurs in production
 * (`evidence-first-claims.md` MUST-6: a green covers the class its instrument could observe).
 */
const AGENT_ID_RE = /^a(?:(.+)-)?([0-9a-f]{16})$/;

/**
 * Resolve a runtime agent id to the DISPATCH NAME it was launched under.
 *
 * @param {string} agentId
 * @returns {{ok: boolean, name: string|null, raw: string}} `ok:false` = unrecognized shape (the
 *   caller MUST treat that as unresolved, never as a name); `name:null` = a genuinely unnamed
 *   dispatch, which has no join key and is reported UNJOINABLE rather than accused.
 */
function normalizeAgentId(agentId) {
  const raw = _isNonEmptyString(agentId) ? agentId : "";
  const m = AGENT_ID_RE.exec(raw);
  if (!m) return { ok: false, name: null, raw };
  return { ok: true, name: _isNonEmptyString(m[1]) ? m[1] : null, raw };
}

/**
 * The agent context a hook payload fired in, expressed in the SAME vocabulary as a launch row's
 * `dispatch_name` so the two can be joined at all. `payload.agent_id` is populated by CC ONLY when
 * the call originates inside a subagent (the empirical finding `provenance-capture-tool.js` records
 * for #448 and `emit-artifact-activation.js` relies on); absent means the main agent.
 *
 * Returns the dispatch NAME when the id resolves to one, and the RAW id otherwise — never a
 * silently-truncated or invented name. A raw id here cannot match any `dispatch_name`, so it lands
 * in `orphan_deliverers`, which forces UNRESOLVED rather than a false accusation (see `reconcile`).
 */
function generationOf(payload) {
  const a = payload && payload.agent_id;
  if (!_isNonEmptyString(a)) return MAIN_GENERATION;
  const n = normalizeAgentId(a);
  return n.ok && n.name ? n.name : a;
}

/**
 * The dispatch NAME from a delegation tool call, or null.
 *
 * The name is the join key on the delivery side: the delegation tool documents it as what "makes
 * it addressable via SendMessage({to: name})", so the launched lane's own `agent_id` is this
 * string. A dispatch with no name is UNJOINABLE and is reported as such — never silently clean and
 * never accused of non-delivery.
 */
function dispatchNameOf(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  return _isNonEmptyString(ti.name) ? ti.name : null;
}

/** The subagent type from a delegation tool call, or null (a dispatch may omit it). */
function subagentTypeOf(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  return _isNonEmptyString(ti.subagent_type) ? ti.subagent_type : null;
}

/**
 * Count the DECLARED sub-parts of a user prompt.
 *
 * A COUNT, deliberately, and not another prose MUST. `agents.md` is `priority: 0`, always loaded,
 * and ALREADY says executing a decomposable input inline-serially is BLOCKED — that counterfactual
 * has run and failed, so adding a sentence cannot fix it. A count has a falsifying result: declared
 * 4, launched 1 is a row; declared 4, launched 4 is not.
 *
 * STRUCTURAL and deterministic — line-anchored list markers only, never a semantic read of the
 * prose. Fenced code blocks are stripped first, because a shell snippet's `- ` lines are not
 * sub-parts of the request. Ordered and unordered groups are counted separately and the LARGER is
 * returned, so a prompt mixing a numbered plan with an incidental bullet is not double-counted.
 *
 * @param {string} text
 * @returns {number} 0 when the prompt declares no enumerated structure
 */
function countDeclaredSubparts(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let ordered = 0;
  let bullets = 0;
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}\d{1,2}[.)]\s+\S/.test(line)) ordered++;
    else if (/^\s{0,3}[-*+]\s+\S/.test(line)) bullets++;
  }
  return Math.max(ordered, bullets);
}

// ── record builders ───────────────────────────────────────────────────────────
// Pure, time-source-agnostic (the caller supplies `nowIso`) so every shape is testable without a
// clock or a repo on disk.

function _base(kind, sessionId, generation, nowIso) {
  return {
    v: LEDGER_SCHEMA_VERSION,
    kind,
    session_id: _isNonEmptyString(sessionId) ? sessionId : "unknown-session",
    generation: _isNonEmptyString(generation) ? generation : MAIN_GENERATION,
    ts: _isNonEmptyString(nowIso) ? nowIso : new Date().toISOString(),
  };
}

/** @returns {object} a `launch` record. `generation` is the PARENT of the dispatched lane. */
function buildLaunchRecord(a) {
  const r = _base("launch", a.sessionId, a.generation, a.nowIso);
  r.launch_id = _isNonEmptyString(a.launchId) ? a.launchId : newLaunchId();
  r.dispatch_name = _isNonEmptyString(a.dispatchName) ? a.dispatchName : null;
  r.subagent_type = _isNonEmptyString(a.subagentType) ? a.subagentType : null;
  return r;
}

/** @returns {object} a `delivery` record. `generation` is the DELIVERER itself. */
function buildDeliveryRecord(a) {
  return _base("delivery", a.sessionId, a.generation, a.nowIso);
}

/** @returns {object} a `declared` record carrying only the COUNT — never the prompt text. */
function buildDeclaredRecord(a) {
  const r = _base("declared", a.sessionId, a.generation, a.nowIso);
  r.declared_subparts = Number.isInteger(a.declaredSubparts) && a.declaredSubparts >= 0 ? a.declaredSubparts : 0;
  return r;
}

/** @returns {object} a `reconcile` record — the reconciler's own verdict, made durable. */
function buildReconcileRecord(a) {
  const r = _base("reconcile", a.sessionId, a.generation, a.nowIso);
  const v = a.verdict && typeof a.verdict === "object" ? a.verdict : {};
  r.state = RECONCILE_STATES.includes(v.state) ? v.state : "UNRESOLVED";
  r.reason = _isNonEmptyString(v.reason) ? v.reason : null;
  r.undelivered_count = Array.isArray(v.undelivered) ? v.undelivered.length : null;
  r.undelivered_lanes = Array.isArray(v.undelivered)
    ? v.undelivered.slice(0, MAX_REPORTED_LANES).map((l) => l.dispatch_name || l.launch_id)
    : null;
  r.parallelism = v.parallelism || null;
  return r;
}

/**
 * Append ONE record to the per-session sink. Best-effort; returns a result object, NEVER throws.
 * @returns {{ok: boolean, sinkPath?: string, error?: string}}
 */
function appendRecord(a) {
  try {
    const repoDir = a.repoDir || process.cwd();
    const record = a.record;
    if (!record || typeof record !== "object" || !RECORD_KINDS.includes(record.kind))
      return { ok: false, error: "record MUST be an object with a known kind" };
    const sinkPath = _sinkPath(repoDir, record.session_id);
    const w = appendSinkLine({ repoDir, sinkPath, line: JSON.stringify(record) });
    if (!w.ok) return { ok: false, error: `${w.error} — ${w.reason}` };
    return { ok: true, sinkPath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Read the per-session sink.
 *
 * TRI-STATE AT THE SOURCE. Absence and unreadability are DISTINCT typed failures, never an empty
 * array — an empty array is indistinguishable from "every lane delivered", which is the
 * non-discriminating instrument this whole module exists to avoid. A malformed LINE is skipped and
 * counted (a torn final row from a short write is not a reason to discard the rest of the file),
 * but a malformed FILE never masquerades as a clean one.
 *
 * @returns {{ok: true, rows: object[], skipped: number} | {ok: false, reason: string}}
 */
function readLedger(a) {
  let sinkPath;
  try {
    const repoDir = (a && a.repoDir) || process.cwd();
    sinkPath = (a && a.sinkPath) || _sinkPath(repoDir, a && a.sessionId);
  } catch (e) {
    return { ok: false, reason: `could not resolve the ledger path: ${e && e.message ? e.message : String(e)}` };
  }
  let text;
  try {
    const st = fs.statSync(sinkPath);
    if (!st.isFile()) return { ok: false, reason: `ledger path ${sinkPath} is not a regular file` };
    if (st.size > MAX_LEDGER_BYTES)
      return { ok: false, reason: `ledger is ${st.size} bytes, over the ${MAX_LEDGER_BYTES}-byte read cap` };
    text = fs.readFileSync(sinkPath, "utf8");
  } catch (e) {
    // ENOENT is the fresh-clone / CI / launch-hook-never-ran case. It is UNRESOLVED, not clean.
    return {
      ok: false,
      reason:
        e && e.code === "ENOENT"
          ? "no dispatch ledger for this session — the launch hook never wrote one (fresh clone, CI, or a session with no dispatches). Delivery status is UNKNOWN, not clean."
          : `dispatch ledger unreadable: ${e && e.message ? e.message : String(e)}`,
    };
  }
  const rows = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && RECORD_KINDS.includes(r.kind)) rows.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { ok: true, rows, skipped };
}

/**
 * The generations in which a lane of each dispatch NAME was launched.
 *
 * THE GENERATION HALF OF THE JOIN. Exported and pure so its refusal branch is directly testable:
 * a name launched in two generations resolves to a two-member set, and `reconcile` then refuses to
 * attribute a delivery from that name to EITHER lane.
 *
 * @param {Iterable<object>} launches
 * @returns {Map<string, Set<string>>}
 */
function attributableGenerations(launches) {
  const byName = new Map();
  for (const L of launches) {
    if (!L || !_isNonEmptyString(L.dispatch_name)) continue;
    const g = _isNonEmptyString(L.generation) ? L.generation : MAIN_GENERATION;
    if (!byName.has(L.dispatch_name)) byName.set(L.dispatch_name, new Set());
    byName.get(L.dispatch_name).add(g);
  }
  return byName;
}

/**
 * Reconcile a ledger's rows into a per-generation delivery verdict.
 *
 * Pure — takes rows, returns plain data. No IO, no clock.
 *
 * @param {object[]|null} rows
 * @param {{reason?: string}} [failure]  when the read failed, its typed reason
 * @returns {{state, reason, generations, undelivered, unjoinable, unattributable, orphan_deliverers, parallelism}}
 */
function reconcile(rows, failure) {
  if (!Array.isArray(rows)) {
    return {
      state: "UNRESOLVED",
      reason: (failure && failure.reason) || "no ledger rows were readable",
      generations: null,
      undelivered: null,
      unjoinable: null,
      unattributable: null,
      orphan_deliverers: null,
      unjoinable_deliverers: null,
      parallelism: null,
    };
  }

  // Keyed by launch_id — the dedupe an append-only sink needs, and the reason launch-id uniqueness
  // is load-bearing rather than cosmetic (see `newLaunchId`).
  const launches = new Map();
  const deliveries = [];
  let lastDeclaredIndex = -1;
  let lastDeclared = null;
  rows.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    if (r.kind === "launch" && _isNonEmptyString(r.launch_id)) launches.set(r.launch_id, r);
    else if (r.kind === "delivery") deliveries.push(r);
    else if (r.kind === "declared") {
      lastDeclaredIndex = i;
      lastDeclared = r;
    }
  });

  const gensForName = attributableGenerations(launches.values());

  // Which (generation, name) pairs a delivery satisfies. A deliverer whose name resolves to more
  // than one generation is UNATTRIBUTABLE and satisfies NOTHING — attributing it would let a
  // nested lane's delivery satisfy a same-named parent lane's missing one.
  //
  // THE GENERATION PREFIX IN THIS KEY IS MEASURED REDUNDANT, and that is recorded rather than
  // quietly left to look load-bearing. Given the `gens.size > 1` refusal below, `gensForName.get()`
  // always holds exactly ONE member and a lane's own generation IS that member, so `${g} ${name}`
  // and `${name}` can never disagree. A reviewer proved it: dropping the prefix at both sites left
  // the suite 38/38 and the fixtures 34/34 green, and a differential fuzz over 4096 cases across
  // the generation × name cross product returned 0 divergences. It is KEPT as defence-in-depth
  // against a future relaxation of the refusal branch — which is the thing that actually
  // discriminates (see there) — but no coverage claim rests on the prefix itself.
  //
  // The composite key's separator is a SPACE, deliberately, and this file HAS ALREADY BEEN BURNED
  // ONCE by the alternative. A raw NUL landed on these three lines while they were being authored;
  // `file(1)` then reported the whole source as `data` and `grep -c LEDGER_SCHEMA_VERSION` returned
  // ZERO MATCHES against a string that was demonstrably present on disk — a silent false negative
  // with no error to see, which is exactly what `validate-emit.mjs::hookEventKey` records ("do not
  // reintroduce one"). A space is safe as a separator here because neither side can contain one:
  // a dispatch name is `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and MAIN_GENERATION is `(main-agent)`.
  const satisfied = new Set(); // `${generation} ${name}`
  const unattributable = new Set();
  const orphanDeliverers = new Set();
  const unjoinableDeliverers = new Set();
  for (const d of deliveries) {
    const emitter = _isNonEmptyString(d.generation) ? d.generation : MAIN_GENERATION;
    // The main agent is not a launched lane, so its own SendMessage calls satisfy no lane.
    if (emitter === MAIN_GENERATION) continue;
    // An UNNAMED lane delivering. Its runtime id parses cleanly but carries no dispatch name, so
    // there is no join key on either side — its own LAUNCH row already sits in `unjoinable`
    // (`dispatch_name === null`). This is EXPECTED and BENIGN, and it must NOT be counted an
    // orphan: an orphan is evidence the join is broken, and letting a legitimately-unnamed lane
    // trip that guard would degrade a whole otherwise-resolvable verdict. Conflating "cannot be
    // joined" with "did not deliver" is the same false-accusation class one level down.
    const parsed = normalizeAgentId(emitter);
    if (parsed.ok && parsed.name === null) {
      unjoinableDeliverers.add(emitter);
      continue;
    }
    const gens = gensForName.get(emitter);
    if (!gens || gens.size === 0) {
      orphanDeliverers.add(emitter);
      continue;
    }
    // THE REFUSAL BRANCH — this is the guard that actually discriminates, and the restated M1-c
    // target. Removing it flips a parent lane's same-named nested delivery into `delivered`
    // (measured: parent `reviewer` → `delivered: ["reviewer"]`), reddening 1 test and 1 fixture.
    // The composite-key generation prefix above does NOT discriminate; this does.
    if (gens.size > 1) {
      unattributable.add(emitter);
      continue;
    }
    satisfied.add(`${[...gens][0]} ${emitter}`);
  }

  const generations = new Map();
  const undelivered = [];
  const unjoinable = [];
  for (const L of launches.values()) {
    const g = _isNonEmptyString(L.generation) ? L.generation : MAIN_GENERATION;
    if (!generations.has(g))
      generations.set(g, { generation: g, launched: [], delivered: [], undelivered: [], unjoinable: [], unattributable: [] });
    const bucket = generations.get(g);
    const lane = {
      launch_id: L.launch_id,
      dispatch_name: _isNonEmptyString(L.dispatch_name) ? L.dispatch_name : null,
      subagent_type: _isNonEmptyString(L.subagent_type) ? L.subagent_type : null,
      generation: g,
    };
    bucket.launched.push(lane);
    if (lane.dispatch_name === null) {
      bucket.unjoinable.push(lane);
      unjoinable.push(lane);
    } else if (unattributable.has(lane.dispatch_name)) {
      bucket.unattributable.push(lane);
    } else if (satisfied.has(`${g} ${lane.dispatch_name}`)) {
      bucket.delivered.push(lane);
    } else {
      bucket.undelivered.push(lane);
      undelivered.push(lane);
    }
  }

  // ── the parallelism rider ───────────────────────────────────────────────────
  // Declared sub-parts vs dispatches launched AFTER that declaration, in the MAIN generation.
  // File ORDER, not timestamps: the sink is append-only, so position is a total order that no
  // clock skew or same-millisecond tie can corrupt.
  let parallelism = null;
  if (lastDeclared) {
    let dispatched = 0;
    for (let i = lastDeclaredIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.kind !== "launch") continue;
      const g = _isNonEmptyString(r.generation) ? r.generation : MAIN_GENERATION;
      if (g === MAIN_GENERATION) dispatched++;
    }
    const declared = Number.isInteger(lastDeclared.declared_subparts) ? lastDeclared.declared_subparts : 0;
    parallelism = {
      declared,
      dispatched,
      shortfall: declared >= 2 && dispatched < declared ? declared - dispatched : 0,
    };
  }

  // ── the fail-safe: an unresolved JOIN must never read as a lane's failure ───
  //
  // An orphan deliverer is an agent that DID deliver and whose name matches no launch row. One
  // benign cause exists (a ledger that began mid-session, so the launch row predates it). The
  // dangerous cause is a JOIN that stopped resolving — which is exactly what shipped in the first
  // cut of this module, where the raw `agent_id` was compared against the dispatch `name` and every
  // delivering lane was reported UNDELIVERED. Under that defect the output is indistinguishable
  // from "nobody delivered", so it is a non-discriminating instrument in this rule's own sense.
  //
  // So: orphans co-occurring with undelivered lanes ⇒ UNRESOLVED, naming the orphans. Orphans with
  // NOTHING undelivered stay RESOLVED — there is no false accusation available to make, so the
  // weaker verdict would only suppress a clean result. Scoped to exactly the case where the harm
  // is possible, rather than blanket-degrading on any orphan.
  if (orphanDeliverers.size > 0 && undelivered.length > 0) {
    return {
      state: "UNRESOLVED",
      reason:
        `${orphanDeliverers.size} agent(s) delivered but match no recorded dispatch ` +
        `(${[...orphanDeliverers].slice(0, MAX_REPORTED_LANES).join(", ")}), while ${undelivered.length} ` +
        "lane(s) would otherwise be reported undelivered. The dispatch↔delivery join is not " +
        "resolving in this runtime, so no lane can be named — re-check the agent-id shape against " +
        "`normalizeAgentId` before reading any lane as silent.",
      generations: null,
      undelivered: null,
      unjoinable: null,
      unattributable: null,
      orphan_deliverers: [...orphanDeliverers],
      unjoinable_deliverers: [...unjoinableDeliverers],
      parallelism,
    };
  }

  return {
    state: "RESOLVED",
    reason: null,
    generations: [...generations.values()],
    undelivered,
    unjoinable,
    unattributable: [...unattributable],
    orphan_deliverers: [...orphanDeliverers],
    unjoinable_deliverers: [...unjoinableDeliverers],
    parallelism,
  };
}

/**
 * Render the verdict as one advisory block, or null when there is nothing to say.
 *
 * NEVER prints a clean claim from an UNRESOLVED verdict: the unresolved branch says the status is
 * UNKNOWN and names why, the same shape `open-pr-surface.js` uses for a failed `gh` round-trip.
 *
 * @param {object} verdict
 * @returns {string|null}
 */
function formatReconcileAdvisory(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.state === "UNRESOLVED") {
    return (
      "[dispatch-reconcile] UNRESOLVED — subagent delivery could not be checked this session: " +
      String(verdict.reason || "no reason recorded") +
      " This is NOT a clean result; do not read it as 'every lane delivered'."
    );
  }
  const lines = [];
  const undelivered = Array.isArray(verdict.undelivered) ? verdict.undelivered : [];
  if (undelivered.length > 0) {
    const shown = undelivered.slice(0, MAX_REPORTED_LANES);
    const more = undelivered.length - shown.length;
    lines.push(
      `[dispatch-reconcile] ${undelivered.length} dispatched lane(s) have NOT called SendMessage — ` +
        "their output is UNDELIVERED and invisible to the orchestrator: " +
        shown.map((l) => `${l.dispatch_name || l.launch_id} (gen ${l.generation})`).join(", ") +
        (more > 0 ? ` … and ${more} more` : "") +
        ". Ask the lane to deliver before assuming it died and redoing the work serially.",
    );
  }
  const unjoinable = Array.isArray(verdict.unjoinable) ? verdict.unjoinable : [];
  if (unjoinable.length > 0)
    lines.push(
      `[dispatch-reconcile] ${unjoinable.length} dispatch(es) carried no \`name\`, so delivery is UNJOINABLE ` +
        "for them — neither clean nor undelivered. Pass `name` to make a lane reconcilable.",
    );
  const unattributable = Array.isArray(verdict.unattributable) ? verdict.unattributable : [];
  if (unattributable.length > 0)
    lines.push(
      `[dispatch-reconcile] ${unattributable.length} dispatch name(s) exist in more than one generation ` +
        `(${unattributable.join(", ")}), so their deliveries cannot be attributed to one lane; those lanes are ` +
        "reported as neither delivered nor undelivered.",
    );
  // The UNNAMED-lane case gets its OWN line, distinct from the orphan line above. It is not a
  // join failure and not an accusation: the lane delivered, and neither side carries a name to
  // join on. Saying "no launch row matches" about it (the orphan wording) would misdescribe a
  // launch row that is PRESENT and merely unjoinable.
  const unjoinableDel = Array.isArray(verdict.unjoinable_deliverers) ? verdict.unjoinable_deliverers : [];
  if (unjoinableDel.length > 0)
    lines.push(
      `[dispatch-reconcile] ${unjoinableDel.length} lane(s) delivered under an UNNAMED dispatch id ` +
        `(${unjoinableDel.slice(0, MAX_REPORTED_LANES).join(", ")}), so the delivery cannot be attributed to a ` +
        "named lane — their launch rows are present but carry no `name`. Neither delivered nor undelivered.",
    );
  const orphans = Array.isArray(verdict.orphan_deliverers) ? verdict.orphan_deliverers : [];
  if (orphans.length > 0)
    lines.push(
      `[dispatch-reconcile] ${orphans.length} deliverer(s) match no recorded dispatch ` +
        `(${orphans.join(", ")}) — no launch row carries a matching dispatch name, so their lanes are unreconciled.`,
    );
  const p = verdict.parallelism;
  if (p && p.shortfall > 0)
    lines.push(
      `[dispatch-reconcile] the last prompt declared ${p.declared} sub-parts and ${p.dispatched} lane(s) were ` +
        "dispatched for it. A decomposable input run inline-serially is BLOCKED (`agents.md` § Triad) — " +
        "parallelize the remaining sub-parts or state why they are not independent.",
    );
  return lines.length > 0 ? lines.join("\n") : null;
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  MAIN_GENERATION,
  RECORD_KINDS,
  RECONCILE_STATES,
  DELEGATION_TOOLS,
  DELIVERY_TOOLS,
  MAX_REPORTED_LANES,
  _sinkPath,
  newLaunchId,
  generationOf,
  normalizeAgentId,
  AGENT_ID_RE,
  dispatchNameOf,
  subagentTypeOf,
  countDeclaredSubparts,
  buildLaunchRecord,
  buildDeliveryRecord,
  buildDeclaredRecord,
  buildReconcileRecord,
  appendRecord,
  readLedger,
  attributableGenerations,
  reconcile,
  formatReconcileAdvisory,
};
