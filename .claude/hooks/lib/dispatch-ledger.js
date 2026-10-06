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
const path = require("path");

// The ONE hardened append primitive (loom#1349) — six defenses, symlink/hardlink/FIFO refusal,
// 0o600 — and its READ counterpart (loom#1762), which applies the same containment plus a byte
// bound enforced by the read itself. A direct `fs.appendFileSync` here would be a second,
// un-hardened sink; a direct `fs.readFileSync` was a second, un-hardened SOURCE, which is exactly
// the asymmetry CRITICAL 1 and CRITICAL 2 were. There is deliberately NO bare `fs` binding in this
// module's scope any more, so reaching for either takes an added import rather than a free hand.
const { appendSinkLine, readSinkFile } = require("./append-sink.js");

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

/**
 * Hard cap on a ledger read. A runaway sink must not turn a shutdown hook into an OOM.
 *
 * THE CAP WAS DECORATIVE UNTIL loom#1762 CRITICAL 2, and the correction is recorded rather than
 * smoothed over. `readLedger` used to `statSync` and then `readFileSync`, so the cap gated only
 * the STAT: a stat reporting 4,194,000 bytes (under the cap) gated a read that MEASURED
 * 71,302,864 bytes consumed. Direct control — `statSync` faked to report `size:100` against a
 * 4 MB file — still returned all 200,000 rows, proving the read ignored the stat entirely and ran
 * to EOF. The cap is now enforced BY THE READ (`append-sink.js::readSinkFile` fills a
 * `maxBytes + 1` buffer), so the bytes consumed cannot exceed it regardless of what a concurrent
 * writer does between any stat and any read.
 */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
/** Hard cap on how many undelivered lanes an advisory names, so one line cannot flood a transcript. */
const MAX_REPORTED_LANES = 12;

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// ── session identity — ONE derivation, five call sites ────────────────────────
//
// ## The defect this closes (loom, 2026-09-01), MEASURED
//
// `appendRecord` keys the sink FILE on the row's own `session_id`, so two sessions can only pool
// into one file when BOTH resolve to the SAME id. Before this change the no-session fallback was
// the SHARED CONSTANT `"unknown-session"`, restated at FIVE independent sites — the producer
// (`emit-dispatch-ledger.js`), the consumer (`delegation-default-guard.js`), the ledger path
// mapper (`_sinkPath`), the record builder (`_base`) and the dedupe path mapper
// (`delegation-default.js::markerPath`). A shared constant where a UNIQUE value is required is a
// name collision BY DESIGN: every id-less session landed in ONE file, and inside it every row AND
// the reader carried that same literal, so `assessSessionVolume`'s fence predicate
// (`r.session_id !== sessionId`) could NEVER be true. No field inside a pooled file can separate
// rows that are byte-identical in the only field that identifies them, which is why the fence
// could not work in principle rather than merely in practice.
//
// Measured with a control: session A ran 12 serial prompts while session B (also id-less) opened
// one lane mid-run. Pooled, the arm reported `QUIET, run 6` — SILENT. With the ids made
// distinguishable it reported `ADVISE, run 12` — the true finding, suppressed by a foreign lane.
//
// The fallback needs NO attacker: `read-stdin-bounded.js` resolves `{}` on TTY stdin, empty
// stdin, a JSON parse error, an over-ceiling payload, or a 2 s timeout.
//
// ## The derivation, and WHY each rung
//
// Ordered most- to least-authoritative, and every site calls `resolveSessionId` so the five
// cannot drift (`rules/security.md` § Multi-Site Kwarg Plumbing — a second copy IS the drift
// class this corpus keeps finding):
//
//   1. the caller's explicit `session_id` — the host's own id, unchanged behaviour.
//   2. `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` from the environment. MEASURED, not
//      assumed: a Claude-Code-spawned child process on this host carries
//      `CLAUDE_CODE_SESSION_ID=<uuid>` and `CLAUDE_PID=<host pid>` in its environment. Note the
//      variable is `CLAUDE_CODE_SESSION_ID`; `validate-bash-command.js` reads the shorter
//      `CLAUDE_SESSION_ID`, which is why its own fallback goes straight to a pid. Both names are
//      tried here so neither host spelling is missed.
//   3. a DERIVED anonymous identity, `unknown-<hostPid>-<8 hex>`, where `<hostPid>` is
//      `CLAUDE_PID` when the host exports it and `process.ppid` otherwise, and the hex is a
//      sha256 over `<hostPid>|<host process start time>`.
//
// WHY THE HOST PID AND NOT `process.pid`. The producer and the consumer are DIFFERENT OS
// processes — one hook fires at `PreToolUse`, the other at `Stop` — so a `process.pid`-derived id
// would put the consumer on a file the producer never wrote. What they share is the process that
// SPAWNED them. `CLAUDE_PID` names it directly and survives a shell in between; `process.ppid`
// is the documented stand-in and is what `validate-bash-command.js` already uses for the same
// purpose (loom#1715 (d)), with the residual that it names an intermediate shell rather than the
// host if one is interposed — which is exactly why `CLAUDE_PID` is preferred over it.
//
// WHY A START-TIME COMPONENT. A pid alone is NOT unique over time: the OS reuses pids, so a later
// session could inherit a dead predecessor's identity and read its history. It IS sufficient
// against the failure that matters — two CONCURRENT sessions cannot hold the same live pid, so
// concurrent pooling is closed by the pid alone — and the start-time hash closes the weaker
// sequential-reuse case on top of it. `ps -o lstart=` is 1-second granular, which is finer than
// pid reuse can be: the reused pid's process starts strictly later than the dead one.
//
// COST AND FAIL-SOFT. `ps` is spawned at most ONCE per process (memoized) and ONLY on rung 3,
// which rungs 1 and 2 make rare — measured on this checkout, 45 of 45 live sinks carry a real
// session UUID. Where `ps` is unavailable (Windows) the token degrades to the literal `nostart`,
// which loses ONLY the sequential-reuse guarantee and keeps the concurrent-pooling closure. The
// degradation is deterministic per host, so a producer and a consumer on one host cannot land on
// different rungs.

/**
 * The SHARED-CONSTANT fallback this stream shipped with, retained as an exported NAME so a
 * reader, a migration or a fixture can address the legacy POOLED sink without restating the
 * literal. NOTHING resolves to it any more; see `legacyAnonSinkPath` for its disposition.
 */
const LEGACY_ANON_SESSION_ID = "unknown-session";

/** Prefix of a DERIVED anonymous identity — greppable, and never the shape of a host UUID. */
const ANON_SESSION_PREFIX = "unknown";

/**
 * Memo for the AMBIENT derivation only. Two calls in one process MUST agree (`_sinkPath` and
 * `_base` both resolve on a single append), and without the memo they would spawn `ps` twice and
 * could straddle a second boundary — producing two different ids inside one write.
 */
let _anonSessionMemo = null;

/** The host process's start time, as an opaque token. `null` when it cannot be obtained. */
function _hostStartToken(hostPid) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(hostPid)], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const t = String(out).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * The derived per-host-process identity. STABLE within a process and across every process the
 * same host spawned; DISTINCT across hosts.
 *
 * `opts` exists for fixtures: supplying `env`, `hostPid` or `startToken` bypasses the memo so both
 * poles can be driven on one tree without a subprocess. The ambient (production) call takes no
 * arguments and is memoized.
 */
function anonymousSessionId(opts) {
  const o = opts || {};
  const ambient =
    o.env === undefined && o.hostPid === undefined && o.startToken === undefined && o.fresh !== true;
  if (ambient && _anonSessionMemo !== null) return _anonSessionMemo;
  const env = o.env || process.env;
  const declared = o.hostPid !== undefined ? o.hostPid : env.CLAUDE_PID;
  const hostPid = /^[0-9]{1,10}$/.test(String(declared == null ? "" : declared))
    ? String(declared)
    : String(process.ppid);
  const start = o.startToken !== undefined ? o.startToken : _hostStartToken(hostPid);
  const basis = `${hostPid}|${_isNonEmptyString(start) ? start : "nostart"}`;
  const id = `${ANON_SESSION_PREFIX}-${hostPid}-${crypto
    .createHash("sha256")
    .update(basis, "utf8")
    .digest("hex")
    .slice(0, 8)}`;
  if (ambient) _anonSessionMemo = id;
  return id;
}

/** Drop the memo. Fixtures only — production never needs it, and calling it mid-session would
 *  re-derive an identity that is supposed to be constant. */
function _resetAnonSessionMemo() {
  _anonSessionMemo = null;
}

/**
 * THE single session-identity resolution for this stream. Every producer, consumer and path
 * mapper routes through it, so the id a row is written under and the id a reader looks for cannot
 * disagree. A whitespace-only id resolves the SAME way here as it does in `_sinkPath` — before
 * this function they disagreed, and a `"  "` id was written into a file keyed on
 * `"unknown-session"`.
 */
function resolveSessionId(explicit, opts) {
  if (_isNonEmptyString(explicit) && explicit.trim().length > 0) return explicit;
  const env = (opts && opts.env) || process.env;
  const fromEnv = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (_isNonEmptyString(fromEnv) && fromEnv.trim().length > 0) return fromEnv;
  return anonymousSessionId(opts);
}

/**
 * BACKWARD COMPATIBILITY — the disposition of the pre-fix pooled sinks, STATED rather than left
 * to be discovered. One exists on this machine
 * (`kailash-coc-py/.claude/learning/dispatch-reconcile/unknown-session-86a371a9.jsonl`), so this
 * is a real case, not a hypothetical.
 *
 *   READABLE: the filename mapping is UNCHANGED, so this path still resolves to exactly the file
 *   the old code wrote, and `readLedger({ repoDir, sessionId: LEGACY_ANON_SESSION_ID })` still
 *   reads it. Nothing is deleted, moved or rewritten.
 *
 *   NOT ADOPTED, deliberately: no derived identity resolves to it. Its rows are a POOL of one or
 *   more sessions that are indistinguishable BY CONSTRUCTION — that is the defect — so handing
 *   them to whichever session happens to run next would import another session's history, which
 *   is the same defect wearing a new name. A session cannot "ignore its own history" here,
 *   because no session can be shown to own these rows.
 *
 *   NOT SILENT: `delegation-default-guard.js` emits a one-line stderr breadcrumb naming this file
 *   when it exists AND the current session is on the derived-anonymous rung, once per session.
 */
function legacyAnonSinkPath(repoDir) {
  return _sinkPath(repoDir, LEGACY_ANON_SESSION_ID);
}

/**
 * Per-session sink file. Injective `session_id` → filename mapping (sanitized token + 8-char
 * sha256 of the RAW id), identical to `artifact-activation-ledger.js::_sinkPath`: two raw ids that
 * sanitize to the same token still land on distinct files, and the charclass strips every path
 * separator so a crafted session id cannot traverse out of the sink dir.
 *
 * The no-session case is resolved by `resolveSessionId` and NOWHERE else — the two-doors defect
 * that bit loom#1500-L3 (a read through one door and a write through the other silently missing
 * each other) is avoided by never normalizing an absent session outside that one function. This
 * docblock previously claimed the normalization lived HERE "and nowhere else", which was FALSE
 * when written: `_base` below, both hooks and `delegation-default.js::markerPath` each carried
 * their own copy of the same literal.
 */
function _sinkPath(repoDir, session) {
  const raw = resolveSessionId(session);
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

// ── dispatch LOCATION — which worktree and branch a dispatch was issued from ──
//
// ## The defect this closes (journal/0607 decision 3, journal/0608 item 6), MEASURED
//
// A launch row recorded WHO launched WHAT and never WHERE. `delegation-default.js::
// attributeLaunchesToLanes` joins a launch row to a lane only through its `lane`/`branch` (by name)
// or `worktree`/`cwd` (by path) value, and `wip-lanes.js::LANE_ATTRIBUTION_KEYS` names exactly those
// four keys — so with none written, EVERY dispatch was unidentified: `laneDepth` reported
// `agents: null` for every lane and `detectUnderPackedLane` reported every session that dispatched
// anything as UNATTRIBUTED. An audit found a 4-item serial lane reading PACKED for the same reason.
//
// ## STRUCTURAL, never from the brief's prose
//
// The location is the dispatching session's working directory — a fact the harness REPORTS on the
// hook payload (`payload.cwd`; see `repo-dir-override.js::unoverriddenSeed`) — resolved through git:
// `worktree` is `git rev-parse --show-toplevel`, `branch` is `git symbolic-ref --quiet --short HEAD`.
// Nothing is read from the dispatch prompt (`rules/probe-driven-verification.md` MUST-6).
//
// WHY `symbolic-ref` AND NOT `rev-parse --abbrev-ref HEAD`. Measured in a temp repo: on a DETACHED
// HEAD `rev-parse --abbrev-ref HEAD` exits 0 printing the literal `HEAD` — a string that would be
// recorded as a branch NAMED "HEAD" — and on an UNBORN branch it exits 128. `symbolic-ref --quiet`
// exits 1 with no output on a detached HEAD (a distinct, nameable state) and answers the branch name
// on an unborn branch. It is the instrument that can return the other answer.
//
// ## Tri-state per key, never an omitted key and never a guess
//
// Every launch row carries `cwd`, `cwd_source`, `worktree`, `branch` and `location_reason`, ALWAYS.
// A value git could not produce is `null`, and `location_reason` says why; a row is never dropped
// because its location did not resolve. A `null` attributes nothing: the consumer reads it as an
// unidentified row (UNATTRIBUTED), never as a dispatch for some lane.
//
// ## Bounded
//
// Two git spawns, each capped at `LOCATION_GIT_TIMEOUT_MS` and further capped at half the budget the
// caller passes (`budgetMs` — the hook passes what is left of its own timeout). Below
// `LOCATION_MIN_TIMEOUT_MS` per call no spawn is attempted and the reason says so.
//
// ## Stated limit — correct behaviour, not a bug
//
// A session whose working directory is a MAIN checkout, but which edits a lane worktree by absolute
// paths, records MAIN's worktree and branch, so its dispatches do NOT attribute to that lane. The
// record says where the session RAN; a lane session runs inside its lane's worktree
// (`rules/agents.md` § Worktree Orchestration), so this is the honest reading, not a miss.

/** The location keys every launch row carries. A superset of the path/name keys a consumer joins. */
const LOCATION_KEYS = Object.freeze(["cwd", "cwd_source", "worktree", "branch", "location_reason"]);

/** Per-spawn cap. Two spawns, so the worst case is twice this, inside the hook's own 4 s timeout. */
const LOCATION_GIT_TIMEOUT_MS = 1000;
/** Below this per call there is no honest attempt to make. */
const LOCATION_MIN_TIMEOUT_MS = 50;

/** The reason a launch row carries when its caller supplied no location at all. */
const NO_LOCATION_REASON =
  "no dispatch location was supplied to buildLaunchRecord, so the worktree and branch were not resolved";

/** First line of a git stderr, bounded — a reason, never a dump. */
function _firstLine(s) {
  const line = String(s || "").split("\n").find((l) => l.trim().length > 0) || "";
  return line.trim().slice(0, 160);
}

/**
 * Run ONE read-only git command in `cwd`. Returns a result object; NEVER throws.
 *
 * Routed through `git-subprocess-env.js` — the resolved binary and the scrubbed environment — so an
 * inherited `GIT_DIR` / `GIT_WORK_TREE` cannot steer which repository answers; the answer is the
 * repository `cwd` is actually inside.
 *
 * @returns {{ok:true, stdout:string} | {ok:false, status:number|null, reason:string}}
 */
function _runGitForLocation(cwd, args, timeoutMs) {
  try {
    const { spawnSync } = require("child_process");
    const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");
    const bin = resolveGitBinary();
    if (!bin) return { ok: false, status: null, reason: "no git binary could be resolved" };
    const r = spawnSync(bin, ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      windowsHide: true,
    });
    if (r.error) {
      return {
        ok: false,
        status: null,
        reason:
          r.error.code === "ETIMEDOUT"
            ? `git ${args[0]} timed out after ${timeoutMs} ms`
            : `git ${args[0]} could not be spawned (${r.error.code || r.error.message})`,
      };
    }
    if (r.status !== 0) {
      const tail = _firstLine(r.stderr);
      return {
        ok: false,
        status: r.status,
        reason: `git ${args[0]} exited ${r.status === null ? `on ${r.signal}` : r.status}${tail ? `: ${tail}` : ""}`,
      };
    }
    return { ok: true, stdout: String(r.stdout || "").trim() };
  } catch (e) {
    return { ok: false, status: null, reason: `git could not be run: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Resolve WHERE a dispatch was issued from. NEVER throws; every key is always present.
 *
 * @param {{cwd?:string, cwdSource?:string, budgetMs?:number,
 *          runGit?:(cwd:string, args:string[], timeoutMs:number)=>object}} a
 *   `runGit` is a fixture seam (a timed-out or failing git without a slow or broken binary).
 * @returns {{cwd:string|null, cwd_source:string|null, worktree:string|null, branch:string|null,
 *           location_reason:string|null}}  `location_reason` is null ONLY when all three resolved.
 */
function resolveDispatchLocation(a) {
  const o = a && typeof a === "object" ? a : {};
  const out = {
    cwd: _isNonEmptyString(o.cwd) ? o.cwd : null,
    cwd_source: _isNonEmptyString(o.cwdSource) ? o.cwdSource : null,
    worktree: null,
    branch: null,
    location_reason: null,
  };
  if (out.cwd === null) {
    out.location_reason =
      "no working directory was received for the dispatching session, so no worktree or branch was resolved";
    return out;
  }
  // A RELATIVE cwd would resolve against the HOOK's process directory, which is not where the
  // session ran — resolving it would be a guess dressed as a measurement.
  if (!path.isAbsolute(out.cwd)) {
    out.location_reason = "the received working directory is not an absolute path, so no worktree or branch was resolved";
    return out;
  }
  const budget = Number.isFinite(o.budgetMs) ? o.budgetMs : 2 * LOCATION_GIT_TIMEOUT_MS;
  const timeoutMs = Math.min(LOCATION_GIT_TIMEOUT_MS, Math.floor(budget / 2));
  if (!(timeoutMs >= LOCATION_MIN_TIMEOUT_MS)) {
    out.location_reason = `no-budget: ${Math.max(0, Math.floor(budget))} ms left, below the ${2 * LOCATION_MIN_TIMEOUT_MS} ms needed to ask git — worktree and branch NOT resolved`;
    return out;
  }
  const run = typeof o.runGit === "function" ? o.runGit : _runGitForLocation;

  const top = run(out.cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (!top || top.ok !== true) {
    out.location_reason = `worktree and branch NOT resolved — ${(top && top.reason) || "git returned no result"}`;
    return out;
  }
  if (!_isNonEmptyString(top.stdout) || !path.isAbsolute(top.stdout)) {
    out.location_reason = "worktree and branch NOT resolved — git rev-parse --show-toplevel returned no absolute path";
    return out;
  }
  out.worktree = top.stdout;

  const b = run(out.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs);
  if (b && b.ok === true && _isNonEmptyString(b.stdout)) {
    out.branch = b.stdout;
  } else if (b && b.ok === false && b.status === 1) {
    out.location_reason = "branch is null: HEAD is detached in this worktree, so it has no branch to name";
  } else {
    out.location_reason = `branch NOT resolved — ${(b && b.reason) || "git symbolic-ref returned no branch name"}`;
  }
  return out;
}

// ── record builders ───────────────────────────────────────────────────────────
// Pure, time-source-agnostic (the caller supplies `nowIso`) so every shape is testable without a
// clock or a repo on disk.

function _base(kind, sessionId, generation, nowIso) {
  return {
    v: LEDGER_SCHEMA_VERSION,
    kind,
    // Routed through the SHARED derivation, not a local fallback. This site and `_sinkPath` are
    // read on the SAME append (`appendRecord` keys the file on the row's own `session_id`), so a
    // second copy here is not a style problem — it is a guaranteed write/read split.
    session_id: resolveSessionId(sessionId),
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
  // WHERE the dispatch was issued from — ALWAYS present, never omitted (§ dispatch LOCATION).
  // COPIED from the caller's `resolveDispatchLocation` result, never resolved here: this builder
  // stays pure (no IO, no clock). A non-string or empty value is recorded null, never coerced.
  const loc = a.location && typeof a.location === "object" ? a.location : null;
  for (const k of ["cwd", "cwd_source", "worktree", "branch"]) r[k] = loc && _isNonEmptyString(loc[k]) ? loc[k] : null;
  if (loc === null) r.location_reason = NO_LOCATION_REASON;
  else if (_isNonEmptyString(loc.location_reason)) r.location_reason = loc.location_reason;
  else if (r.cwd !== null && r.worktree !== null && r.branch !== null) r.location_reason = null;
  else r.location_reason = "the supplied dispatch location left a key null without a reason";
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
 * but a malformed FILE never masquerades as a clean one. "Malformed" INCLUDES a blank or
 * whitespace-only line — see the loop below for why it must, and for the one blank that is not a
 * line at all (the JSONL terminator's split artifact).
 *
 * @returns {{ok: true, rows: object[], skipped: number}
 *          | {ok: false, reason: string, absent: boolean, overCap: boolean}}
 */
function readLedger(a) {
  let sinkPath;
  try {
    const repoDir = (a && a.repoDir) || process.cwd();
    sinkPath = (a && a.sinkPath) || _sinkPath(repoDir, a && a.sessionId);
  } catch (e) {
    // NOT `absent`: the path could not even be formed, so nothing was shown to be missing. A
    // failure that cannot say whether the file exists must not claim the quiet disposition.
    return {
      ok: false,
      absent: false,
      overCap: false,
      reason: `could not resolve the ledger path: ${e && e.message ? e.message : String(e)}`,
    };
  }
  // THE READ IS CONTAINED AND BOUNDED, and neither was true before (loom#1762 CRITICAL 2).
  //
  // This routes through the SAME primitive the WRITE half uses — `append-sink.js` — rather than
  // re-deriving a containment check that would drift from it (`rules/security.md` § Path
  // Containment; § Multi-Site Kwarg Plumbing). `readSinkFile` resolves both the candidate and the
  // declared root through the same resolver, refuses a symlinked ancestor, a symlinked sink, a
  // hard-linked sink and a swapped sink directory, and — the CRITICAL-2 half — fills a
  // `MAX_LEDGER_BYTES + 1` buffer so the bytes consumed are bounded BY THE READ.
  //
  // A file OVER the cap is refused WHOLESALE, including one that grows past it mid-read (MEASURED
  // boundary: exactly MAX_LEDGER_BYTES reads, MAX_LEDGER_BYTES + 1 refuses).
  // That is the deliberate answer to "what happens to a truncated final line": there is never a
  // truncated final line, because a prefix is never returned. A cut line is either unparseable
  // (noise in `skipped`) or — worse — still parses into a SHORTER, WRONG record, and this reader's
  // whole contract is that a malformed FILE never masquerades as a clean one.
  let text;
  {
    const r = readSinkFile({
      repoDir: (a && a.repoDir) || process.cwd(),
      sinkPath,
      maxBytes: MAX_LEDGER_BYTES,
    });
    if (!r.ok) {
      // ENOENT is the fresh-clone / CI / launch-hook-never-ran case. It is UNRESOLVED, not clean.
      //
      // `absent` IS THE DISCRIMINATOR, and it is carried on the failure shape rather than left to
      // a string-match on `reason` (loom#1762, the third defect). Before it, an over-cap ledger, a
      // symlinked ledger and an ENAMETOOLONG session id all returned a bare `ok:false` that
      // rendered BYTE-IDENTICALLY to a well-delegating session: the refusal reason was computed
      // and then discarded. A caller can now ask "was this merely missing?" structurally.
      return {
        ok: false,
        absent: r.absent === true,
        overCap: r.overCap === true,
        reason: r.absent
          ? "no dispatch ledger for this session — the launch hook never wrote one (fresh clone, CI, or a session with no dispatches). Delivery status is UNKNOWN, not clean."
          : `dispatch ledger unreadable: ${r.error} — ${r.reason}`,
      };
    }
    text = r.text;
  }
  // A BLANK LINE IS SKIPPED CONTENT, NOT ABSENT CONTENT (2026-09-01). This loop used to
  // `continue` past every blank line WITHOUT counting it, and that omission put three file shapes
  // into the SILENT partition that belong in the BROKEN-INSTRUMENT one:
  //
  //     a ZERO-BYTE sink                 -> rows 0, skipped 0 -> SILENT
  //     a whitespace-only sink           -> rows 0, skipped 0 -> SILENT
  //     spaces with no trailing newline  -> rows 0, skipped 0 -> SILENT
  //
  // while an all-unparseable sink and an unknown-`kind` sink both correctly reported a BROKEN
  // INSTRUMENT. Downstream (`delegation-default.js::assessSessionVolume`) the whole partition
  // keys on `prompts === 0 && skipped > 0`, so a file that READ successfully and yielded nothing
  // rendered BYTE-IDENTICALLY to a well-delegating session — the same non-discriminating-instrument
  // shape the tri-state exists to prevent, reached through a different door.
  //
  // A ZERO-BYTE SINK IS NOT HYPOTHETICAL — it is the WRITE half's own residue, and the module that
  // produces it is the same one whose reader scored it clean. `append-sink.js::appendSinkLine`
  // opens the sink with `O_CREAT` and then refuses on several POST-OPEN checks (fstat failure,
  // `nlink > 1`, an identity mismatch, a stalled write), so a refused append leaves a created,
  // never-written file at the LEGITIMATE in-tree path. Its header records the out-of-tree twin as
  // residual (a): a won create race "CREATES a ZERO-BYTE file at the attacker's target". A torn
  // create is therefore the ordinary residue of the hardening itself, not an exotic input.
  //
  // THE TRAILING-NEWLINE ARTIFACT IS NOT A BLANK LINE, and conflating them reds the honest case.
  // JSONL terminates every row with "\n", so `"row\n".split("\n")` yields a final "" that is an
  // artifact of the TERMINATOR, never a line in the file. It is dropped — and only when the text
  // genuinely ended with a newline, which is what keeps a zero-byte file (`"".split("\n")` is also
  // `[""]`, with no terminator behind it) inside the counted population. Fixture cases 135-138
  // pin both poles: the three residue shapes now speak, and an honest trailing-newline ledger is
  // still `skipped === 0`.
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const rows = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      skipped++;
      continue;
    }
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
  LEGACY_ANON_SESSION_ID,
  ANON_SESSION_PREFIX,
  resolveSessionId,
  anonymousSessionId,
  legacyAnonSinkPath,
  _resetAnonSessionMemo,
  MAIN_GENERATION,
  RECORD_KINDS,
  RECONCILE_STATES,
  DELEGATION_TOOLS,
  DELIVERY_TOOLS,
  MAX_REPORTED_LANES,
  // EXPORTED so a fixture can drive the cap boundary without RESTATING the literal. A test that
  // hard-codes 4 MB stays green while the constant moves, and the two readers of one number then
  // silently disagree — the same coupling failure `assertFloorMatchesReconciler` exists to stop for
  // DECLARED_FLOOR. (A fixture drafted against the unexported name silently wrote a ZERO-byte file
  // via `"x".repeat(NaN)` and passed the over-cap case VACUOUSLY; that is how this was found.)
  MAX_LEDGER_BYTES,
  _sinkPath,
  newLaunchId,
  generationOf,
  normalizeAgentId,
  AGENT_ID_RE,
  dispatchNameOf,
  subagentTypeOf,
  countDeclaredSubparts,
  LOCATION_KEYS,
  LOCATION_GIT_TIMEOUT_MS,
  NO_LOCATION_REASON,
  resolveDispatchLocation,
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
