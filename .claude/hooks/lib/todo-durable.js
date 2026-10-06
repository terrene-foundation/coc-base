"use strict";

/**
 * todo-durable.js — derive work-state from the DURABLE todo surface STRUCTURALLY.
 *
 * WHY THIS EXISTS. The Work Ledger's only producer was registered at
 * `PostToolUse:TodoWrite` and gated on `p.tool_name !== "TodoWrite"`. That tool is
 * not available by default on current models (it and the `TaskCreate`/`TaskUpdate`/
 * `TaskList`/`TaskGet` API that superseded it are both off unless explicitly
 * enabled), so the gate never opens and the ledger holds ZERO `kind: transition`
 * records. MEASURED: feeding the shipped guard an `Edit` on a durable todo path
 * returns a bare `{"continue":true}` — no path exists from the durable surface to
 * the log.
 *
 * WHY IT READS THE PATH AND NOT THE PROSE. Two independent bars point the same way.
 *
 *   1. `probe-driven-verification.md` MUST-6 forbids production code inferring a
 *      semantic value from free-form text.
 *   2. It would not work anyway. MEASURED over the tracked surface: 160 todo files
 *      carry 1 `**Status**:` line, 0 `# TODO-` headings and 0 `000-master.md`
 *      indexes — the `todo-manager` format contract is declared and essentially
 *      unused. A reader built on it would report ~0 items and read as "no work".
 *
 * WHAT IS ACTUALLY PRODUCED, and therefore what this reads. The `/todos` lifecycle
 * step "move completed todos to `completed/`" IS performed: 20 files under
 * `todos/active/`, 79 under `todos/completed/`. The DIRECTORY is the producer's
 * declaration. It is structural, deterministic, and cannot be misread — a path
 * segment is a git-object fact, not a sentence someone has to interpret.
 *
 * THE ID IS STABLE ACROSS THE MOVE, which is the whole trick. An id derived from
 * the FULL path would make `active/foo.md → completed/foo.md` look like one item
 * deleted and a different one created, and the transition — the only thing worth
 * recording — would be exactly what got lost. So the id is (workspace, basename)
 * and the DIRECTORY is the state, never part of the identity.
 *
 * THREE OUTCOMES, kept distinct because collapsing any two of them is the defect:
 *
 *   DECLARED   — the path names a recognised lifecycle directory; state is read.
 *   UNDECLARED — a todo-tree file in NO directory on the `LIFECYCLE_DIRS` allowlist.
 *                NOT "no state". Reported, never counted as absent. (Named by the
 *                allowlist rather than enumerated here: the enumeration read
 *                "`active/` or `completed/`" and was already false when `done` was
 *                added, so the list is stated ONCE, where it is defined.)
 *   MALFORMED  — a path that cannot be parsed at all. REFUSED, never skipped: a
 *                skipped unparseable path is indistinguishable from a clean scan.
 *
 * IDEMPOTENT BY CONSTRUCTION. This module REPORTS current state and emits nothing.
 * The caller diffs against the fold and appends only what changed, so a second run
 * appends nothing. That is what lets the triggers be redundant — a `PostToolUse`
 * reconcile, a `SessionStart` sweep and a `SessionEnd` sweep may all fire and the
 * extra runs are free. NO SINGLE TRIGGER IS LOAD-BEARING, which is precisely the
 * property whose absence produced this entire failure class: the old producer had
 * exactly one trigger, that trigger disappeared, and nothing noticed for months.
 */

const path = require("node:path");

/** The agent work-state namespace. `burndown-events.js::validateEvent` REFUSES a
 * non-owner transition carrying anything outside it, so every status this module
 * yields is prefixed here — an agent may never assign an owner-vocabulary status
 * (`Signed off`, `In progress`, …). Mirrors `todo-tracker.js::TODO_STATUS_PREFIX`. */
const TODO_STATUS_PREFIX = "todo:";

/**
 * The lifecycle directories the `/todos` loop actually maintains, mapped to the
 * work-state each one DECLARES. This is a POSITIVE allowlist (`cc-artifacts.md`
 * Rule 10): a directory outside it is UNDECLARED, never guessed at. Adding a
 * lifecycle directory is a contract change that lands here, deliberately.
 */
const LIFECYCLE_DIRS = new Map([
  ["active", "active"],
  ["completed", "completed"],
  // `done` is a SECOND closure directory the producer actually produces, mapped to
  // the SAME work-state so one vocabulary reaches the log. It is not a typo and not
  // a guess: MEASURED on this tree, 49 tracked `.md` sit under `todos/done/` across
  // eight LIVE workspaces, and `git log --follow --name-status` shows each arriving
  // by RENAME out of `active/` (`R100 …/todos/active/00-wave-plan.md →
  // …/todos/done/00-wave-plan.md` at `9341f9397`, subject "move 5 converged
  // workstreams' active todos to done"; `R100` again at `391bb2c1b`, "Wave-1
  // close"). It also already has a READER: `.claude/bin/codify-backlog.mjs:319`
  // does `collect("todos/done", out.done)`.
  //
  // Before this entry those 49 closed items reported as `lifecycle-undeclared`,
  // i.e. as state nobody had measured — so the census was reporting its OWN
  // allowlist's ignorance in the grammar of the world's uncertainty, which is the
  // noise that trains a reader past a real signal.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO: pick a winner in the `done/`-vs-`completed/`
  // naming fork. The prose authorities say `completed/` (`agents/management/
  // todo-manager.md:26`, `commands/implement.md:28`, `commands/ws.md:18`,
  // `sync-manifest.yaml:1524`, and the `workspaces/_template/todos/` scaffold);
  // `commands/codify.md:49` + `codify-backlog.mjs` say `done/`. Both are live, with
  // real producers and real consumers, and reconciling the NAME is a contract change
  // for an operator, not a side effect of fixing a count. Recognising both makes the
  // census true without resolving the fork. No id collision results: MEASURED, zero
  // (workspace, basename) pairs appear under more than one lifecycle directory.
  ["done", "completed"],
  // `_archive` is a THIRD closure directory the producer actually produces, and it
  // gets its OWN work-state rather than being folded into `completed`. Same evidence
  // shape as the `done` entry above, measured on this tree rather than assumed:
  // 1 tracked `.md` sits under a `todos/_archive/` directory in a LIVE workspace
  // (`workspaces/multi-operator-coc/todos/_archive/00-todos.md`), and
  // `git log --follow --name-status` shows it arriving by RENAME out of `active/` —
  // `R100 …/todos/active/00-todos.md → …/todos/_archive/00-todos.md` at `e15242007`,
  // subject "chore(triage): discard 49 converged-workstream journal auto-stubs +
  // archive superseded 00-todos". The instrument discriminates: the same command's
  // next entry is an `A` (`A …/todos/active/00-todos.md` at `3b6ee81cd`), so it does
  // emit ADD when a file was authored in place, and the `R100` is a true rename.
  //
  // Before this entry that file reported as `lifecycle-undeclared` — i.e. as state
  // NOBODY HAD MEASURED — when the producer had in fact declared one by moving it,
  // deliberately, with the act named in the commit subject. That is the census
  // reporting its own allowlist's ignorance in the grammar of the world's
  // uncertainty, the same defect the `done` entry closed one directory earlier.
  //
  // WHY `archived` AND NOT `completed`. The directory declares removal from the
  // WORKLIST; it does not declare that the work FINISHED — this one was SUPERSEDED.
  // `diffTransitions` writes the state into the durable ledger, which is a permanent
  // institutional record, so mapping it to `completed` would write a completion
  // nobody declared (`zero-tolerance.md` Rule 3). It is still CLOSED below, because
  // closed means "no longer outstanding", which archiving does assert.
  //
  // A NEW STATE IS A SECOND SURFACE, learned in the SAME change per `security.md`
  // § Enforcement-Surface Parity: `.claude/bin/activity-build.mjs` keeps an
  // INDEPENDENT closed-status set with no shared callee, and anything absent from it
  // reads as in-flight. `todo:archived` is added there in this change. The third
  // set, `todo-tracker.js::CLOSED_TODO_STATUSES`, belongs to the TodoWrite producer,
  // which never emits this state and is deliberately left alone.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO: prefix-match `_`. An exact name is added to
  // a POSITIVE allowlist (`cc-artifacts.md` Rule 10). The corpus holds a SECOND
  // underscore directory under `todos/` with DIFFERENT semantics — 11 tracked `.md`
  // under `workspaces/_archive/terrene-stack-gaps/todos/_archive-build-delegated/`,
  // which hold unfinished work belonging to another BUILD repo, not closed work — so
  // a prefix rule would declare live work closed. Those 11 stay UNDECLARED and are
  // currently withheld from the lane census anyway by `isMetaWorkspaceTodoPath`
  // (their workspace id starts with `_`); the day that workspace un-archives they
  // surface as `lifecycle-undeclared`, which is the true answer for them.
  //
  // Nor does it resolve the `done/`-vs-`completed/` naming fork, for the reason the
  // `done` entry records. No id collision results: MEASURED on this tree, zero
  // (workspace, basename) pairs appear under more than one lifecycle directory.
  ["_archive", "archived"],
]);

/** States meaning the item is no longer outstanding (mirrors todo-tracker.js). */
const CLOSED_TODO_STATES = new Set(["completed", "archived"]);

/** POSIX-normalise so a Windows-separated path classifies identically. */
function posix(rel) {
  return String(rel == null ? "" : rel)
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "");
}

/**
 * Classify ONE todo path into {id, state} — pure, deterministic, path-only.
 *
 * Shape: `workspaces/<ws>/todos/<lifecycle>/<...>/<name>.md`
 *
 * The id deliberately EXCLUDES the lifecycle segment (see the module header): it
 * is `<ws>/<name>`, so the same item keeps one identity as it moves and the move
 * reads as a TRANSITION rather than a delete plus an unrelated create.
 */
function classifyTodoPath(relPath) {
  const rel = posix(relPath);
  if (!rel) return { ok: false, reason: "empty path" };
  const parts = rel.split("/");
  if (parts[0] !== "workspaces")
    return { ok: false, reason: "not under workspaces/" };
  if (!rel.endsWith(".md")) return { ok: false, reason: "not a markdown file" };

  // LOCATE the `todos` segment rather than assuming its index. A workspace id is
  // NOT always one segment: MEASURED on the real corpus, `workspaces/_archive/
  // <name>/todos/active/…` is ordinary, and a fixed `parts[2] === "todos"` test
  // reported 106 of 174 tracked files as MALFORMED — a classifier so rigid it
  // condemns the majority of its own subject, while reading like a corpus problem
  // rather than a reader problem. Search for the segment; take everything before
  // it as the workspace id, so nesting depth is irrelevant.
  const idx = parts.indexOf("todos");
  if (idx < 1) return { ok: false, reason: "no todos/ segment" };
  if (idx + 2 > parts.length - 1)
    return { ok: false, reason: "nothing under todos/<lifecycle>/" };
  const ws = parts.slice(1, idx).join("/");
  const lifecycle = parts[idx + 1];
  if (!ws) return { ok: false, reason: "empty workspace segment" };

  const state = LIFECYCLE_DIRS.get(lifecycle);
  const name = parts[parts.length - 1].replace(/\.md$/, "");
  if (!name) return { ok: false, reason: "empty file name" };

  // UNDECLARED is a REPORTED outcome, not a failure and not an absence: the file
  // is in the todo tree but in no lifecycle directory, so the producer has not
  // declared a state for it. Saying "no state" here would let a whole class of
  // files read as done.
  if (!state) {
    return {
      ok: true,
      outcome: "undeclared",
      id: `${ws}/${name}`,
      rel,
      lifecycle,
    };
  }
  return {
    ok: true,
    outcome: "declared",
    id: `${ws}/${name}`,
    rel,
    lifecycle,
    state,
    status: TODO_STATUS_PREFIX + state,
    closed: CLOSED_TODO_STATES.has(state),
  };
}

/**
 * Is this todo path inside a workspace META-directory rather than a live workspace?
 *
 * TRUE iff any segment of the WORKSPACE ID (everything between `workspaces/` and
 * the `todos` segment) begins with `_` — `workspaces/_archive/<ws>/todos/…`,
 * `workspaces/_template/todos/…`, `workspaces/_draft/…`. Pure, path-only, and
 * deliberately the same predicate `cc-artifacts.md:139-148` Rule 8 already
 * mandates for workspace-walking hooks ("filter directories whose name starts
 * with underscore (`_archive`, `_template`, `_draft`, etc.)"), so this is that
 * rule's SEMANTICS reused, not a new convention invented here.
 *
 * WHY IT IS NEEDED AT ALL. Rule 8's existing instances are all readdir-side
 * predicates. The two censuses over this corpus do not readdir — they use the git
 * PATHSPEC `workspaces/*\/todos/**`, where `*` CROSSES `/`, so
 * `workspaces/_archive/<ws>/todos/active/x.md` matches and the archive was never
 * filtered. That is the whole mechanism by which 92 archived `.md` entered a
 * census of outstanding work.
 *
 * IT SCOPES A POPULATION; IT DOES NOT RECLASSIFY A PATH. `classifyTodoPath`
 * still reads an archived path as ORDINARY and DECLARED — the deliberate,
 * measured behaviour its own comment defends and `audit-fixtures/
 * todo-durable-ingest/run.mjs:216-244` pins as a named regression case. The
 * durable LEDGER legitimately records the archive's history; what must not treat
 * a closed archive as outstanding is the LANE-DEPTH census, and that is a
 * question about which files to ASK about, not about what a path MEANS.
 */
function isMetaWorkspaceTodoPath(relPath) {
  const parts = posix(relPath).split("/");
  if (parts[0] !== "workspaces") return false;
  const idx = parts.indexOf("todos");
  if (idx < 1) return false;
  return parts.slice(1, idx).some((seg) => seg.startsWith("_"));
}

/**
 * Build the CURRENT declared state of the whole durable surface.
 *
 * `listFiles` is injected rather than shelling out here: the caller decides
 * whether the population is `git ls-files` (TRACKED only — the durability bar
 * `burndown-traceability.md` MUST-2 sets) or a fixture's list. A module that
 * chose for itself could not be tested without a real repository.
 *
 * A DUPLICATE id is refused rather than resolved. Two files claiming one identity
 * means one of them is about to be silently dropped by whichever wins, and a
 * first-wins or last-wins rule here would pick a winner nobody declared.
 */
function scanDurableTodos(listFiles) {
  const files = typeof listFiles === "function" ? listFiles() : listFiles;
  if (!Array.isArray(files))
    return { ok: false, reason: "listFiles did not yield an array" };

  const declared = new Map();
  const undeclared = [];
  const malformed = [];
  const collisions = [];

  for (const f of files) {
    const c = classifyTodoPath(f);
    if (!c.ok) {
      malformed.push({ rel: posix(f), reason: c.reason });
      continue;
    }
    if (c.outcome === "undeclared") {
      undeclared.push({ rel: c.rel, id: c.id, lifecycle: c.lifecycle });
      continue;
    }
    const prior = declared.get(c.id);
    if (prior && prior.rel !== c.rel) {
      collisions.push({ id: c.id, rels: [prior.rel, c.rel] });
      continue;
    }
    declared.set(c.id, {
      id: c.id,
      rel: c.rel,
      state: c.state,
      status: c.status,
      closed: c.closed,
    });
  }
  return { ok: true, declared, undeclared, malformed, collisions };
}

/**
 * Diff the current declared state against the last-known fold, yielding the
 * transitions that MUST be appended — and nothing else.
 *
 * `known` is a `Map<id, status>` projected from the fold. An id whose status is
 * unchanged yields NOTHING, which is what makes the whole mechanism idempotent
 * and every trigger redundant rather than duplicative.
 *
 * An id present in `known` but ABSENT from the scan yields NO event. Absence is
 * not evidence of completion — a file may be untracked, renamed, or on another
 * branch — and inventing a terminal transition from a missing file would write a
 * fact nobody declared. Retirement is an owner adjudication (`retraction`), never
 * an inference from a vanished path.
 */
function diffTransitions(scan, known) {
  if (!scan || scan.ok !== true)
    return { ok: false, reason: "scan did not succeed" };
  const prior = known instanceof Map ? known : new Map();
  const transitions = [];
  for (const [id, cur] of scan.declared) {
    const was = prior.get(id);
    if (was === cur.status) continue;
    transitions.push({
      item_id: id,
      status: cur.status,
      rel: cur.rel,
      prior: was || null,
    });
  }
  return { ok: true, transitions };
}

/** A log-sourced value, bounded for an operator-facing line: no control bytes, capped length. */
function safeLabel(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    .slice(0, 120);
}

/** `line 3, line 9, … (+N more)` — every hit up to the cap, and the total past it. */
function lineList(entries, cap = 5) {
  const shown = entries
    .slice(0, cap)
    .map((s) => `line ${s.line}`)
    .join(", ");
  return entries.length > cap
    ? `${shown} (+${entries.length - cap} more)`
    : shown;
}

/**
 * Render the event-log fold's skips BY CLASS for the durable-todo guard's report.
 *
 * WHY. The guard used to print `skipped.length` as "event-log line(s) were UNREADABLE",
 * so a valid proposal waiting for its owner countersignature was reported as corruption.
 * `skipped[]` holds two opposite populations, and the class of each entry is set at the
 * PRODUCER (`burndown-events.js::SKIP_KINDS`, grouped by `partitionSkips`). This renders
 * that partition; it never re-derives a class from `why` prose.
 *
 * `classes` is `partitionSkips(fold)`. Returns operator-facing lines, one per non-empty
 * class; an empty array means there is nothing to report. A RESOLVED proposal (one a later
 * activation countersigned) is permanent history, not outstanding work, and is not reported.
 * Unreadable and unclassified lines are NEVER omitted: a log with either must not read like
 * a clean fold. Log bytes are not echoed for unreadable lines — only their line numbers.
 */
function describeFoldSkips(classes) {
  const c = classes || {};
  const lines = [];
  const unreadable = Array.isArray(c.unreadable) ? c.unreadable : [];
  const unclassified = Array.isArray(c.unclassified) ? c.unclassified : [];
  const awaiting = Array.isArray(c.awaitingActivation)
    ? c.awaitingActivation
    : [];
  const fenced = Array.isArray(c.fenced) ? c.fenced : [];
  if (unreadable.length) {
    lines.push(
      `${unreadable.length} event-log line(s) were UNREADABLE and skipped by the fold ` +
        `(${lineList(unreadable)}). A log with unreadable lines and one that folded clean ` +
        `MUST NOT read identically.`,
    );
  }
  if (unclassified.length) {
    lines.push(
      `${unclassified.length} event-log skip(s) carry NO known class (${lineList(unclassified)}) and ` +
        `are treated as UNREADABLE: a skip nobody can name must not read as benign.`,
    );
  }
  if (awaiting.length) {
    const named = awaiting
      .slice(0, 5)
      .map(
        (s) =>
          `'${safeLabel(s.item_id)}' (record ${safeLabel(s.record_id)}, line ${s.line})`,
      )
      .join(", ");
    lines.push(
      `${awaiting.length} proposal(s) AWAITING OWNER ACTIVATION: ${named}` +
        `${awaiting.length > 5 ? ` (+${awaiting.length - 5} more)` : ""}. Each is a valid record that ` +
        `changes nothing until an owner countersigns it with an 'activation' event.`,
    );
  }
  if (fenced.length) {
    const byKind = new Map();
    for (const s of fenced) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind).push(s);
    }
    const parts = [...byKind].map(
      ([kind, list]) => `${list.length}× ${kind} (${lineList(list, 3)})`,
    );
    lines.push(
      `${fenced.length} well-formed event(s) were declined by a fold fence, not unreadable: ${parts.join("; ")}.`,
    );
  }
  return lines;
}

/*
 * ── THE LANE BINDING (journal/0607 decision 3) ─────────────────────────────
 *
 * An OUTSTANDING item declares the lane that carries it with ONE top-level key in
 * its leading YAML frontmatter:
 *
 *     ---
 *     lane: codify/<operator>-2026-09-12-wip-ledger
 *     ---
 *
 * The value is a git BRANCH name — the key `wip-lanes.js::laneSurvey` reports its
 * lanes under — so the join is exact string equality and a name containing `/`
 * round-trips unchanged.
 *
 * WHY A FRONTMATTER FIELD AND NOT A PATH SEGMENT, measured rather than preferred
 * (this tree, 2026-09-12, `git ls-files 'workspaces/*\/todos/**'`):
 *
 *   1. A path binding would REINTERPRET a shape this module already accepts.
 *      `classifyTodoPath` takes `todos/<lifecycle>/<...>/<name>.md` — any depth of
 *      nesting — as ONE item. On this tree 0 tracked `.md` sit below a lifecycle
 *      directory, but the contract ships to every repo, and a consumer that groups
 *      `active/wave-1/*.md` would have its grouping directories silently read as
 *      lane names. A NEW key reinterprets nothing: 160 tracked todo `.md` files,
 *      64 already carry a leading `---` block, and 0 carry a `lane:` key (the same
 *      probe fires on a control file that has one).
 *   2. A branch name is not always a legal path. Git accepts `<`, `>`, `|` and `"`
 *      in a ref; Windows refuses all four in a file name. A path segment cannot
 *      round-trip every lane name on every client OS; a string value can.
 *
 * WHY IT IS STILL STRUCTURAL (`probe-driven-verification.md` MUST-6). The producer
 * WRITES the key; nothing is inferred from prose. The parser reads one delimited
 * block, one anchored key, and validates the value against git's own branch-name
 * grammar. A value that fails is MALFORMED — reported, never guessed at, never
 * read as unbound — and a key declared twice is MALFORMED rather than first-wins.
 *
 * ADDITIVE BY CONSTRUCTION. Nothing above changes: the id stays (workspace,
 * basename), the state stays the lifecycle DIRECTORY, and `scanDurableTodos` /
 * `diffTransitions` still never read file content. The binding is a SEPARATE read
 * over the scan's result, so no existing fold or transition can move because a
 * `lane:` key was added or edited.
 */

/** The frontmatter key. One name, exported, so no reader restates the literal. */
const LANE_KEY = "lane";

/** Bytes of a file's head the binding reader examines. Frontmatter sits at the top. */
const LANE_HEAD_BYTES = 8192;

/**
 * Git's branch-name grammar (`git check-ref-format --branch`), as a POSITIVE
 * check. Refused: empty, whitespace or control bytes, any of `~ ^ : ? * [ \`,
 * `..`, `@{`, a leading `-` or `/`, a trailing `/` or `.`, `//`, a component
 * starting with `.`, and a component ending `.lock`. MEASURED against git on 16
 * names (4 accepted, including `<`, `|` and `"`; 12 refused): every verdict agrees.
 *
 * ONE deliberate divergence: a bare `@` is refused here. `--branch @` exits 0 only
 * because branch mode EXPANDS `@` to the current branch, and `refs/heads/@` is a
 * valid full ref — but a lane literally named `@` would be read as "whatever is
 * checked out", so it cannot be a stable join key. Such a binding reads MALFORMED.
 */
function isLaneName(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(v)) return false;
  if (v.includes("..") || v.includes("@{") || v === "@") return false;
  if (
    v.startsWith("-") ||
    v.startsWith("/") ||
    v.endsWith("/") ||
    v.endsWith(".")
  )
    return false;
  if (v.includes("//")) return false;
  return v
    .split("/")
    .every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}

/**
 * Read the lane binding out of a file's HEAD text — pure, no I/O.
 *
 * @param {string} text the first `LANE_HEAD_BYTES` of the file
 * @returns {{outcome:"bound", lane:string, line:number}
 *          |{outcome:"unbound", reason:string}
 *          |{outcome:"malformed", reason:string}}
 */
function parseLaneBinding(text) {
  if (typeof text !== "string")
    return { outcome: "malformed", reason: "content was not text" };
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---")
    return { outcome: "unbound", reason: "no leading frontmatter block" };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  // An unclosed block is NOT "no lane": the key may sit past the part we read, so
  // saying unbound would assert an absence nobody measured.
  if (close === -1) {
    return {
      outcome: "malformed",
      reason: `frontmatter opened with --- and not closed within ${LANE_HEAD_BYTES} bytes`,
    };
  }
  const hits = [];
  for (let i = 1; i < close; i++) {
    const m = /^lane:(.*)$/.exec(lines[i]);
    if (m) hits.push({ line: i + 1, raw: m[1] });
  }
  if (hits.length === 0)
    return {
      outcome: "unbound",
      reason: `frontmatter declares no \`${LANE_KEY}:\` key`,
    };
  if (hits.length > 1) {
    return {
      outcome: "malformed",
      reason: `\`${LANE_KEY}:\` declared ${hits.length} times (lines ${hits.map((h) => h.line).join(", ")}) — no winner is picked`,
    };
  }
  let v = hits[0].raw.trim();
  const quoted =
    v.length >= 2 &&
    ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")));
  if (quoted) v = v.slice(1, -1);
  else v = v.replace(/\s+#.*$/, "").trim(); // a trailing YAML comment; a branch name holds no space
  if (!isLaneName(v)) {
    return {
      outcome: "malformed",
      reason: `\`${LANE_KEY}:\` value ${JSON.stringify(safeLabel(v))} is not a valid branch name`,
    };
  }
  return { outcome: "bound", lane: v, line: hits[0].line };
}

/**
 * Read the lane binding of every OUTSTANDING declared item in a scan.
 *
 * Only open items are read: a completed item carries no depth. `readHead` is
 * injected for the same reason `listFiles` is — the caller owns I/O, so both poles
 * are testable without a repository. A read that throws is `unreadable`, a FOURTH
 * outcome, never folded into unbound.
 *
 * The scan is NOT mutated; the returned rows are new objects.
 *
 * @returns {{ok:true, items:Array<{id,rel,outcome,lane?,reason?}>}|{ok:false, reason}}
 */
function bindOpenItems(scan, readHead) {
  if (!scan || scan.ok !== true || !(scan.declared instanceof Map))
    return { ok: false, reason: "scan did not succeed" };
  if (typeof readHead !== "function")
    return { ok: false, reason: "readHead is not a function" };
  const items = [];
  for (const it of scan.declared.values()) {
    if (it.closed) continue;
    let text;
    try {
      text = readHead(it.rel);
    } catch (e) {
      items.push({
        id: it.id,
        rel: it.rel,
        outcome: "unreadable",
        reason: safeLabel((e && e.message) || e),
      });
      continue;
    }
    const b = parseLaneBinding(text);
    items.push(
      b.outcome === "bound"
        ? { id: it.id, rel: it.rel, outcome: "bound", lane: b.lane }
        : { id: it.id, rel: it.rel, outcome: b.outcome, reason: b.reason },
    );
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, items };
}

module.exports = {
  LANE_KEY,
  LANE_HEAD_BYTES,
  isLaneName,
  parseLaneBinding,
  bindOpenItems,
  describeFoldSkips,
  TODO_STATUS_PREFIX,
  LIFECYCLE_DIRS,
  CLOSED_TODO_STATES,
  classifyTodoPath,
  isMetaWorkspaceTodoPath,
  scanDurableTodos,
  diffTransitions,
};
