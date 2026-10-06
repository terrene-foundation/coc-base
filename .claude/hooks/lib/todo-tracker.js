#!/usr/bin/env node
/**
 * todo-tracker.js — the PURE half of the `todos → index` producer.
 *
 * `burndown-traceability.md` names four layers and two joins:
 *
 *     INVENTORY → INDEX → CONTEXT → VIEW
 *
 * `inventory → index → context → view` is ARMED and CI-gated (`burndown-build.mjs
 * --check-links` reports 267 items resolving, and `audit-fixtures/burndown-integrity/`
 * proves its discrimination). `todos → index` did NOT exist: `TodoWrite` carried no
 * hook, so the agent's own live work-state reached the index by PROSE CONTRACT ONLY.
 * This module is the projection that closes it, and `todo-tracker-guard.js` is the
 * event surface that drives it.
 *
 * NOTHING HERE TOUCHES THE FILESYSTEM, `git`, OR THE CLOCK-AS-AMBIENT-STATE. Every
 * function is a pure map from (payload, now) to a value, so both poles of every
 * fixture pair run the same code the hook runs, with no environment to arrange.
 * The hook owns I/O; this owns the decisions.
 *
 * ── THE ID IS THE JOIN KEY, AND IT IS DERIVED, NOT INVENTED ───────────────────
 *
 * `checkLinks` joins on the ledger table's `id` column — `rows.get(item.id)` — after
 * `parseLedger` keys the table by header NAME. So a produced row is only reachable
 * if its `id` cell is a STABLE identity for the todo across every status transition.
 * A `TodoWrite` payload carries NO id: only `content`, `status`, `activeForm`. Of
 * those, `content` is the one that is constant across the transitions we must track
 * and different between todos we must not merge — so the id is derived from it.
 *
 * `todo-<12 hex of sha256(content)>-<slug of content>`:
 *
 *   - STABLE across `pending → in_progress → completed`, which is the entire point:
 *     an id that moved with status would append a new row per transition and
 *     `parseLedger` REFUSES a duplicate id, breaking the 267-item chain outright.
 *   - UNIQUE by the hash half.
 *   - DESCRIPTIVE by the slug half, which is not decoration: `burndown-build.mjs`
 *     enforces `MIN_ID_LEN = 8` precisely because LINK-3 matches the id as a
 *     SUBSTRING of the context artifact, so a short or bare-ordinal id certifies
 *     nothing. The slug is what makes `git grep -F <id>` land on one thing.
 */

"use strict";

const crypto = require("node:crypto");

/**
 * The ratified staleness bound: 24 hours, the SAME bound `wip-discipline.md`
 * MUST-3 sets for lanes. One bound across both surfaces is one thing to remember,
 * and the two failures are the same failure — work whose state stopped being true.
 */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * `burndown-build.mjs::MIN_ID_LEN`. Mirrored rather than imported: that file is an
 * ESM `bin/` entrypoint with no export surface, and a `require` of it from a hook
 * would execute its CLI. Mirroring a constant is a drift risk, so the value is
 * asserted against the generator by the fixture runner rather than assumed here.
 */
const MIN_ID_LEN = 8;

/**
 * A hard ceiling on the context artifact. It is a DURABLE, append-mostly surface,
 * so unbounded growth is the failure it would otherwise reach. At the cap the
 * producer reports UNKNOWN and stops writing rather than pruning: pruning would
 * delete the LINK-3 back-reference for ids whose ledger rows remain, which is the
 * exact originating failure `burndown-traceability.md` § Origin records (the
 * context for eleven register ids was PRUNED, not never-written).
 */
const CONTEXT_CAP_BYTES = 512 * 1024;

/** The status vocabulary this producer writes, namespaced so it CANNOT be read as an owner status.
 *
 * `burndown-integrity.md` fixes a CLOSED vocabulary for burndown counts (`Signed off`,
 * `Built-not-walked`, `In progress`, `Not started`, `Blocked on you`, `Open`), and
 * `burndown-traceability.md` MUST-4 says statuses are the OWNER's — an agent MUST NOT
 * set or advance one. So every value here carries a `todo:` prefix: it is a projection
 * of the agent's own live work-state, it is not a burndown status, and no reader can
 * mistake one for the other. `parseLedger` does not read the status column at all, so
 * these values feed no count.
 */
const TODO_STATUS_PREFIX = "todo:";

/** Statuses that mean the todo is no longer outstanding. */
const CLOSED_TODO_STATUSES = new Set(["completed", "cancelled"]);

/**
 * Slugify a todo's content into the descriptive half of its id.
 *
 * Lowercased, non-alphanumerics collapsed to `-`, trimmed, capped. The cap keeps a
 * ledger row readable in a 5-column markdown table; the hash half already carries
 * the uniqueness, so truncation here costs nothing but readability.
 */
function slugifyTodo(content) {
  return String(content || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/**
 * Derive the stable join key for one todo. See § THE ID IS THE JOIN KEY above.
 *
 * Returns `null` for a todo with no usable content: a row keyed on the empty string
 * would collide with every other content-less todo, and a colliding id is worse than
 * an absent row — it silently binds two todos to one ledger entry.
 */
function deriveTodoId(content) {
  const c = typeof content === "string" ? content.trim() : "";
  if (!c) return null;
  const hash = crypto.createHash("sha256").update(c, "utf8").digest("hex").slice(0, 12);
  const slug = slugifyTodo(c);
  const id = slug ? `todo-${hash}-${slug}` : `todo-${hash}`;
  // Unreachable with a 12-hex hash (`todo-` + 12 = 17), asserted rather than assumed:
  // if MIN_ID_LEN ever rises above the hash-only form, LINK-3 would start certifying
  // nothing and this is the only place that would notice.
  return id.length >= MIN_ID_LEN ? id : null;
}

/** Normalize one todo from a `TodoWrite` payload. Returns `null` if unusable. */
function normalizeTodo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  const id = deriveTodoId(content);
  if (!id) return null;
  const status = typeof raw.status === "string" && raw.status ? raw.status : "pending";
  return { id, content, status };
}

/**
 * Extract the todo list from a `PostToolUse` payload, or `null` when this is not a
 * `TodoWrite` at all.
 *
 * `null` and `[]` are DIFFERENT answers and the caller must be able to tell them
 * apart: `null` is "wrong event, produce nothing" (the fall-through pole), `[]` is
 * "a TodoWrite that cleared the list", which is a real event with a real projection
 * (nothing new to mirror). Collapsing them would make the wrong-event pole
 * indistinguishable from an empty-list pole and the fixture pair vacuous.
 */
function extractTodos(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (p.tool_name !== "TodoWrite") return null;
  const src = p.tool_input && Array.isArray(p.tool_input.todos) ? p.tool_input.todos : null;
  if (!src) return null;
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    const t = normalizeTodo(raw);
    if (!t) continue;
    // Two todos with identical content derive one id. Keeping both would append a
    // duplicate ledger row, which `parseLedger` REFUSES — so the LAST one wins and
    // the collision is reported by the caller rather than written.
    if (seen.has(t.id)) {
      const at = out.findIndex((x) => x.id === t.id);
      out[at] = t;
      continue;
    }
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Render the ledger cells for one todo.
 *
 * `value_anchor` points at the context artifact this producer maintains, with the id
 * as the fragment — so the chain reads from BOTH ends exactly as LINK-3 requires:
 * the row names the artifact, and the artifact carries the id verbatim. A row with
 * an empty or prose anchor would be `burndown-traceability.md` MUST-2's "decoration",
 * which to any scanner keyed on non-emptiness reads exactly like a filled-in link.
 */
function projectRow(todo, contextRel) {
  return {
    id: todo.id,
    // `agent`, never a resolved operator identity. Two reasons, both load-bearing:
    // resolving one costs a `git` subprocess (measured 24 ms) on an event that fires
    // constantly, and `$USER` as a display_id is a FABRICATED identity. The row IS
    // agent-authored — saying so is true, free, and attributes nothing to a human.
    // The merge driver reconciles by row id, not by this column.
    owner: "agent",
    item: todo.content,
    value_anchor: `${contextRel}#${todo.id}`,
    status: `${TODO_STATUS_PREFIX}${todo.status}`,
  };
}

// ── THE CONTEXT ARTIFACT ─────────────────────────────────────────────────────
//
// One `### <id>` section per todo, carrying `first_seen` and the todo's text.
//
// `first_seen` is why this file exists at all beyond LINK-3. `wip-discipline.md`
// MUST-3 requires age to derive from CREATION and BLOCKS deriving it from
// `stat().mtime` — measured there, the reaper read a tree as 11.1h from mtime whose
// reflog showed 44h. A todo has no reflog, so the creation instant must be RECORDED
// the first time it is seen, and it must be recorded somewhere durable. That is this
// file. Without it, every age this producer reports would be a mtime read wearing a
// timestamp's grammar.

const CONTEXT_PREAMBLE = [
  "# Todo context — the LINK-3 back-reference for todo-derived Forest-Ledger rows",
  "",
  "GENERATED by `.claude/hooks/todo-tracker-guard.js` on `PostToolUse(TodoWrite)`.",
  "Do not hand-edit: the producer rewrites this file whole on every projection, so a",
  "hand-edit is lost at the next todo change. To change what a row says, change the todo.",
  "",
  "Each section below is the context artifact for one row in the Forest Ledger",
  "(`.session-notes.shared.md`). The heading carries the row's `id` VERBATIM, which is",
  "what makes LINK-3 (`burndown-traceability.md`) resolve from this end.",
  "",
  "`first_seen` is stamped in UTC the first time a todo is observed and is NEVER",
  "recomputed — it is the creation instant `wip-discipline.md` MUST-3 requires, and the",
  "reason age here is not a `stat().mtime` read.",
  "",
].join("\n");

/**
 * Parse the context artifact into `Map<id, {first_seen, status, todo}>`.
 *
 * Tolerant by design: an unparseable section is SKIPPED rather than refused. The
 * consequence of skipping is that the id looks new and gets a fresh `first_seen`,
 * which UNDER-reports age. That is the safe direction — the alternative (refusing)
 * would take the producer offline over a formatting defect in a file it owns.
 */
function parseContext(text) {
  const out = new Map();
  if (typeof text !== "string" || !text) return out;
  const lines = text.split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^###\s+(\S+)\s*$/);
    if (h) {
      if (cur) out.set(cur.id, cur.rec);
      cur = { id: h[1], rec: { first_seen: null, status: "", todo: "" } };
      continue;
    }
    if (!cur) continue;
    const f = line.match(/^-\s+(first_seen|status|todo):\s*(.*)$/);
    if (!f) continue;
    if (f[1] === "first_seen") cur.rec.first_seen = f[2].trim() || null;
    else if (f[1] === "status") cur.rec.status = f[2].trim();
    else cur.rec.todo = f[2].trim();
  }
  if (cur) out.set(cur.id, cur.rec);
  return out;
}

/** Render the context artifact from the merged entry map. Deterministic ordering. */
function renderContext(entries) {
  const ids = [...entries.keys()].sort();
  const parts = [CONTEXT_PREAMBLE];
  for (const id of ids) {
    const e = entries.get(id);
    parts.push(
      [
        `### ${id}`,
        `- first_seen: ${e.first_seen}`,
        `- status: ${e.status}`,
        // A newline in a todo would break the one-line field shape, so it is folded.
        `- todo: ${String(e.todo || "").replace(/\s*\n\s*/g, " ")}`,
        "",
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

/**
 * Merge the observed todos into the parsed context.
 *
 * `first_seen` is preserved for a known id and stamped ONCE for a new one — never
 * recomputed, which is the whole contract. Entries for ids not in this payload are
 * KEPT: a completed todo drops out of the list while its ledger row remains, and
 * dropping its context would break LINK-3 for a row that still exists.
 *
 * `nowIso` is a PARAMETER, not a `new Date()` call inside. That is what lets a
 * fixture pin the clock, and it is also the guard against the local-time skew that
 * wrote an 8-hour-forward stamp into a ledger this month — the caller passes
 * `new Date().toISOString()`, which is UTC by definition.
 */
function mergeContext(prev, todos, nowIso) {
  const next = new Map(prev);
  for (const t of todos) {
    const existing = next.get(t.id);
    next.set(t.id, {
      first_seen: (existing && existing.first_seen) || nowIso,
      status: t.status,
      todo: t.content,
    });
  }
  return next;
}

/**
 * Age distribution over OPEN todos, plus the rows past the ratified bound, BY NAME.
 *
 * `wip-discipline.md` MUST-3 and its paired MUST NOT: a WIP surface reported as a
 * bare COUNT cannot distinguish flow from rot, so it trains its reader to ignore it
 * — measured at 63% noise, after which the surface was correctly ignored. "52 lanes
 * opened and closed in a session is healthy flow; six at 477h is rot — a count
 * reports both identically." So this returns a DISTRIBUTION and the NAMES, and the
 * caller is required to render both.
 *
 * CLOSED todos are excluded: a completed todo is not stale, it is done. Including
 * them would make the distribution drift upward forever and re-create the noise.
 */
function ageReport(entries, todos, nowMs, staleMs = STALE_MS) {
  const openIds = new Set(todos.filter((t) => !CLOSED_TODO_STATUSES.has(t.status)).map((t) => t.id));
  const aged = [];
  for (const id of openIds) {
    const e = entries.get(id);
    if (!e || !e.first_seen) continue;
    const t = Date.parse(e.first_seen);
    if (!Number.isFinite(t)) continue;
    aged.push({ id, ageMs: Math.max(0, nowMs - t) });
  }
  aged.sort((a, b) => a.ageMs - b.ageMs);
  const hours = (ms) => Math.round((ms / 3_600_000) * 10) / 10;
  const at = (q) => (aged.length ? aged[Math.min(aged.length - 1, Math.floor(q * (aged.length - 1)))].ageMs : 0);
  return {
    open: aged.length,
    p50: hours(at(0.5)),
    p90: hours(at(0.9)),
    max: hours(aged.length ? aged[aged.length - 1].ageMs : 0),
    past: aged
      .filter((a) => a.ageMs > staleMs)
      .map((a) => ({ id: a.id, ageHours: hours(a.ageMs) }))
      .sort((a, b) => b.ageHours - a.ageHours),
    boundHours: Math.round(staleMs / 3_600_000),
  };
}

/**
 * Render the B4 staleness surface. Distribution FIRST, then every row past bound by
 * name — never a bare count. `open` is stated with its denominator per
 * `burndown-integrity.md` MUST-2: a quantity with no bucket and no denominator is
 * the shape every irreconcilable figure took.
 */
function renderAgeReport(rep) {
  const head =
    `${rep.past.length} of ${rep.open} open todo(s) are past the ${rep.boundHours}h bound ` +
    `(age from first_seen: p50 ${rep.p50}h, p90 ${rep.p90}h, max ${rep.max}h).`;
  if (rep.past.length === 0) return head;
  return [head, "Past bound, BY NAME (a count cannot separate flow from rot):"]
    .concat(rep.past.map((r) => `  - ${r.id} — ${r.ageHours}h`))
    .join("\n");
}

module.exports = {
  STALE_MS,
  MIN_ID_LEN,
  CONTEXT_CAP_BYTES,
  TODO_STATUS_PREFIX,
  CLOSED_TODO_STATUSES,
  CONTEXT_PREAMBLE,
  slugifyTodo,
  deriveTodoId,
  normalizeTodo,
  extractTodos,
  projectRow,
  parseContext,
  renderContext,
  mergeContext,
  ageReport,
  renderAgeReport,
};
