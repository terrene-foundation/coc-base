#!/usr/bin/env node
/**
 * session-notes-guard.js — the structural detector for
 * `rules/session-notes-continuity.md` (MUST-1 read-order, MUST-2 no-truncate-read,
 * MUST-3 boundedness).
 *
 * @hook-event: PreToolUse:Read (guard) — the subject is the READ ITSELF: whether it
 *   carries truncation parameters, and whether it is the session's first continuity
 *   read. Both facts exist ONLY as the pending tool call. PostToolUse is too late —
 *   by then the agent already holds a silently-partial file and cannot tell it from a
 *   complete one, which is the entire failure mode. No earlier event knows the read is
 *   coming. `Read` is the sole matcher because a continuity artifact is consumed via
 *   the Read tool; a Bash `cat` is out of scope and stated rather than implied.
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (guard) — the subject is the artifact's SIZE
 *   AFTER the write, which is only knowable once the bytes are on disk. PreToolUse
 *   cannot see the post-write length of an Edit (it holds a replacement string, not the
 *   resulting file), and blocking the write would strand the content being organised —
 *   so this arm is deliberately post-hoc and advisory.
 *
 * SEVERITY SPLIT, and why it is not uniform (`hook-output-discipline.md` MUST-2):
 *   MUST-2 → `block`. `tool_input.limit` / a non-zero `tool_input.offset` is read
 *     DIRECTLY off the tool call. It is an irrefutable STRUCTURAL fact about the
 *     invocation — not a lexical match, not a heuristic over content — which is the
 *     narrow class MUST-2 reserves `block` for (the same grounds
 *     `analyze-completeness-guard.js` blocks on an empty-directory `readdirSync`). The
 *     operator's recovery path is one keystroke: re-issue the Read without the
 *     parameter. A block that costs one retry is the correct trade against a partial
 *     directive read that is undetectable downstream.
 *   MUST-1 → `halt-and-report`. Read ORDER is inferred from per-session marker state,
 *     not from the call, so it is judgment-bearing and MUST NOT block.
 *   MUST-3 → `advisory`. Blocking a write would strand content.
 *
 * FAIL-OPEN ON EVERY PATH. No identity, no session id, an unreadable marker, an
 * unclassifiable path, a malformed payload, an exception — all resolve to
 * `{continue:true}`. A `cc-artifacts.md` Rule 7 timer bounds a hang.
 *
 * ORDERING STATE lives in `os.tmpdir()`, keyed by (repo root hash, sanitized
 * session_id) — NEVER in the repo. A repo-side marker would be a new tracked/ignored
 * surface for a purely ephemeral fact, and would contend under N concurrent operators
 * exactly as the pre-split `.session-notes` monolith did. Absent `session_id` → the
 * ordering question is UNANSWERABLE, so MUST-1 suppresses (it never guesses).
 *
 * KNOWN, BOUNDED IMPRECISION, recorded rather than hidden: the marker is written at
 * PreToolUse, i.e. before the Read is known to have SUCCEEDED. A root read denied by a
 * later hook still marks the session as ordered. The error is one-directional — it can
 * only SUPPRESS a MUST-1 advisory, never cause a block — so it fails safe.
 *
 * Origin: rules/session-notes-continuity.md § Origin (2026-08-12 Gate-1 ingest).
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// cc-artifacts.md Rule 7 — fail-open timer. Exit 1 (not 0) marks a timeout-FIRED
// passthrough as distinguishable from a normal one in exit-code logs (parity with
// session-notes-incorporation-guard.js). Armed only inside `_main()`, so a
// `require()` of this module for fixtures has ZERO side effects.
const TIMEOUT_MS = 5000;
let _timeout = null;

/** `rules/session-notes-continuity.md` MUST-3 bounds. Target is surfaced as the goal;
 *  only the CEILING fires, because advising at 151 lines would fire on every /wrapup. */
const NOTES_TARGET_LINES = 150;
const NOTES_CEILING_LINES = 300;

const FRAGMENT_DIR_NAME = ".session-notes.d";
// A continuity artifact's basename: `.session-notes` itself, or any dotted extension
// of it (`.session-notes.shared.md`, `.session-notes.aggregate.md`, `.migrated`).
// Anchored so `x.session-notes` or `.session-notesX` do NOT match.
const NOTES_BASENAME_RE = /^\.session-notes(\.|$)/;

/**
 * Normalize `filePath` to a repo-relative POSIX path. Returns null when the path is
 * empty, or resolves OUTSIDE `repoDir` (a path this hook has no standing to classify).
 * Lexical only — no `realpath`. That is deliberate and bounded: this resolve feeds an
 * ADVISORY/one-retry-block decision, not a trust boundary, so `security.md` § Path
 * Containment's resolve-both-sides mandate (which governs containment and
 * spawn-allowlist decisions) is not in play. The worst case from a symlink is a missed
 * advisory, never an escape.
 */
function toRepoRel(repoDir, filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  if (!repoDir || typeof repoDir !== "string") return null;
  let rel;
  try {
    const root = path.resolve(repoDir);
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(root, filePath);
    rel = path.relative(root, abs);
  } catch {
    return null;
  }
  if (!rel || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Classify a path as a session-notes continuity artifact.
 *
 * `surface` is the load-bearing field:
 *   "root"      — the DIRECTIVE surface: anything at the repo root matching
 *                 `.session-notes*`, plus any fragment under a root `.session-notes.d/`.
 *                 Reading ANY of these satisfies MUST-1's fragment-first precondition
 *                 (deliberately generous — the root forest ledger and the aggregate both
 *                 carry standing rows, so treating them as satisfying keeps the
 *                 false-positive rate at zero for an operator who reads root-first at all).
 *   "workspace" — the NARRATIVE surface: `workspaces/<ws>/.session-notes*` (and any
 *                 fragment beneath a workspace-level `.session-notes.d/`, which
 *                 `commands/wrapup.md` § Where to write already documents as invisible
 *                 to the next session's read path).
 *   "other"     — a continuity-shaped path somewhere else in the tree. Governed by
 *                 MUST-2 (truncation), but neither satisfies nor triggers MUST-1.
 *
 * @returns {{kind:string, surface:"root"|"workspace"|"other", rel:string,
 *            workspace:string|null} | null}
 */
function classifyNotesPath(repoDir, filePath) {
  const rel = toRepoRel(repoDir, filePath);
  if (!rel) return null;
  const segs = rel.split("/");
  const base = segs[segs.length - 1];

  const fragIdx = segs.indexOf(FRAGMENT_DIR_NAME);
  const inFragmentDir = fragIdx !== -1 && fragIdx < segs.length - 1;
  if (!inFragmentDir && !NOTES_BASENAME_RE.test(base)) return null;

  const anchorIdx = inFragmentDir ? fragIdx : segs.length - 1;
  let surface;
  let workspace = null;
  if (anchorIdx === 0) {
    surface = "root";
  } else if (segs[0] === "workspaces" && anchorIdx === 2) {
    surface = "workspace";
    workspace = segs[1];
  } else {
    surface = "other";
  }

  const kind = inFragmentDir
    ? "fragment"
    : base === ".session-notes"
      ? "monolith"
      : base === ".session-notes.shared.md"
        ? "ledger"
        : base === ".session-notes.aggregate.md"
          ? "aggregate"
          : "notes-adjacent";

  return { kind, surface, rel, workspace };
}

/**
 * Is this Read request a TRUNCATION? Returns a human-readable descriptor of the
 * offending parameter, or null when the read is whole.
 *
 * `offset: 0` with no `limit` is NOT a truncation — it names the start of the file and
 * withholds nothing. That boundary is explicit because it is the one case where a
 * present parameter is benign, and a guard that got it wrong would block a correct read.
 */
function truncationOf(limit, offset) {
  const present = (v) => v !== undefined && v !== null && v !== "";
  if (present(limit)) {
    const n = Number(limit);
    return `limit=${Number.isFinite(n) ? n : String(limit)}`;
  }
  if (present(offset)) {
    const n = Number(offset);
    if (Number.isFinite(n) && n === 0) return null;
    return `offset=${Number.isFinite(n) ? n : String(offset)}`;
  }
  return null;
}

/**
 * PURE decision function for the PreToolUse(Read) arm — the fixture surface.
 *
 * @param {{repoDir:string, filePath:string, limit?:*, offset?:*,
 *          rootNotesSeen?:boolean|null}} opts
 *   `rootNotesSeen` is TRI-STATE. `true` → a root artifact was already read this
 *   session. `false` → definitively not. `null`/undefined → UNKNOWN (no session id, or
 *   the marker could not be read), in which case MUST-1 SUPPRESSES rather than guesses.
 * @returns {{action:"pass"|"block"|"advise", reason:string, rel?:string, ...}}
 */
function decideReadGate(opts) {
  const o = opts || {};
  const cls = classifyNotesPath(o.repoDir, o.filePath);
  if (!cls) return { action: "pass", reason: "not-a-continuity-artifact" };

  // MUST-2 first: a truncated read is the structural, block-grade fact, and it applies
  // to EVERY continuity surface including the root one.
  const truncation = truncationOf(o.limit, o.offset);
  if (truncation) {
    return {
      action: "block",
      reason: "truncated-read",
      rel: cls.rel,
      surface: cls.surface,
      truncation,
    };
  }

  // MUST-1: a workspace NARRATIVE read before any root DIRECTIVE read.
  if (cls.surface === "workspace" && o.rootNotesSeen === false) {
    return {
      action: "advise",
      reason: "narrative-before-directive",
      rel: cls.rel,
      surface: cls.surface,
      workspace: cls.workspace,
    };
  }

  return {
    action: "pass",
    reason:
      cls.surface === "root"
        ? "root-continuity-read"
        : o.rootNotesSeen === null || o.rootNotesSeen === undefined
          ? "order-unknown-suppress"
          : "ordered",
    rel: cls.rel,
    surface: cls.surface,
  };
}

/** Line count of a file body. A trailing newline terminates the last line rather than
 *  starting an empty one, so a 3-line file ending in "\n" counts 3, not 4. */
function countLines(content) {
  if (typeof content !== "string" || content === "") return 0;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n").length;
}

/**
 * PURE decision function for the PostToolUse(Edit|Write) arm — the fixture surface.
 * Fires ONLY above the ceiling; `lineCount` that is not a finite number (the file could
 * not be read, was oversize, or was a symlink) suppresses — an unavailable measurement
 * is zero evidence, never a finding (`evidence-first-claims.md` MUST-3).
 */
function decideCeilingAdvisory(opts) {
  const o = opts || {};
  const cls = classifyNotesPath(o.repoDir, o.filePath);
  if (!cls) return { action: "pass", reason: "not-a-continuity-artifact" };
  if (!Number.isFinite(o.lineCount)) {
    return { action: "pass", reason: "line-count-unavailable", rel: cls.rel };
  }
  if (o.lineCount > NOTES_CEILING_LINES) {
    return {
      action: "advise",
      reason: "over-ceiling",
      rel: cls.rel,
      lineCount: o.lineCount,
      ceiling: NOTES_CEILING_LINES,
      target: NOTES_TARGET_LINES,
    };
  }
  return { action: "pass", reason: "within-ceiling", rel: cls.rel, lineCount: o.lineCount };
}

// ---- per-session ordering marker (os.tmpdir(), never the repo) ---------------

/**
 * Marker path for (repo, session). Returns null when no usable session id is present —
 * which the caller MUST translate to `rootNotesSeen: null` (UNKNOWN), not `false`.
 * The session id is sanitized to a filename-safe charset before it reaches a path.
 */
function markerPathFor(repoDir, sessionId) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  if (!safe || /^_+$/.test(safe)) return null;
  let tag;
  try {
    tag = crypto
      .createHash("sha256")
      .update(path.resolve(repoDir || "."))
      .digest("hex")
      .slice(0, 12);
  } catch {
    return null;
  }
  return path.join(os.tmpdir(), `coc-notes-order-${tag}-${safe}`);
}

/** Tri-state read of the marker: true / false / null (UNKNOWN — no marker path, or an
 *  errored stat). Never throws. */
function readRootNotesSeen(markerPath) {
  if (!markerPath) return null;
  try {
    return fs.existsSync(markerPath);
  } catch {
    return null;
  }
}

/** Best-effort marker write. A failure is silent BY DESIGN: it can only cause a
 *  duplicate advisory later, never a block, so surfacing it would be noise. */
function markRootNotesSeen(markerPath) {
  if (!markerPath) return false;
  try {
    fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ---- CLI entry (only when invoked directly, never on require) ----------------

function passthrough() {
  if (_timeout) clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function _readArm(payload, repoDir, hookEvent) {
  const ti = payload.tool_input || {};
  const filePath = ti.file_path || ti.path || "";
  const cls = classifyNotesPath(repoDir, filePath);
  if (!cls) return passthrough(); // cheap short-circuit: not our surface

  const markerPath = markerPathFor(repoDir, payload.session_id);
  const rootNotesSeen = readRootNotesSeen(markerPath);
  const decision = decideReadGate({
    repoDir,
    filePath,
    limit: ti.limit,
    offset: ti.offset,
    rootNotesSeen,
  });

  const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));

  if (decision.action === "block") {
    if (_timeout) clearTimeout(_timeout);
    emit({
      hookEvent,
      severity: "block",
      what_happened: `Truncated read of a session-notes continuity artifact BLOCKED — Read(${decision.rel}) carried ${decision.truncation}.`,
      why: "session-notes-continuity.md MUST-2 — a truncated continuity read is indistinguishable at act-time from a complete one (the tool returns content, not a signal that content was withheld), so every downstream decision inherits the gap with full confidence. The truncation parameter is read directly off the tool call — an irrefutable structural fact, which is the narrow class hook-output-discipline.md MUST-2 reserves `block` for.",
      agent_must_report: [
        `Blocked read: ${decision.rel} (${decision.truncation})`,
        "Re-issue the SAME Read with no `limit` and no non-zero `offset` — continuity artifacts are read whole.",
        `If the file is too large to read whole, that is a MUST-3 breach (ceiling ${NOTES_CEILING_LINES} lines): move the overflow to a NAMED file and leave a pointer, then read the bounded notes.`,
      ],
      agent_must_wait:
        "Do not proceed on a partial continuity read. Re-issue the read whole, or bound the artifact first.",
      user_summary: `session-notes-continuity MUST-2 — truncated read of ${decision.rel} blocked (${decision.truncation})`,
    });
    return; // emit() exits
  }

  if (decision.action === "advise") {
    // Mark BEFORE emitting so the advisory fires at most once per session — a guard
    // that repeats on every subsequent narrative read trains the operator to ignore it.
    markRootNotesSeen(markerPath);
    if (_timeout) clearTimeout(_timeout);
    emit({
      hookEvent,
      severity: "halt-and-report",
      what_happened: `Reading workspace NARRATIVE notes (${decision.rel}) before any ROOT continuity artifact has been read this session.`,
      why: "session-notes-continuity.md MUST-1 — the per-operator fragment carries standing DIRECTIVES and the workspace notes carry project NARRATIVE. The narrative never cites the directive it omits, so an agent that reads it first and acts has no signal that anything is missing.",
      agent_must_report: [
        `Narrative read: ${decision.rel}`,
        "Read the ROOT continuity surface first — .session-notes.aggregate.md (the regenerated view of every fragment), or your own .session-notes.d/<display_id>.md.",
        "Where the two disagree, the fragment's directives govern; the narrative is STALE until reconciled.",
      ],
      agent_must_wait:
        "Advisory — the read proceeds. Read the root artifact before acting on this narrative.",
      user_summary: `session-notes-continuity MUST-1 — narrative (${decision.rel}) read before any root directive artifact`,
    });
    return; // emit() exits
  }

  if (decision.surface === "root") markRootNotesSeen(markerPath);
  return passthrough();
}

function _writeArm(payload, repoDir, hookEvent) {
  const ti = payload.tool_input || {};
  const filePath = ti.file_path || ti.path || "";
  const cls = classifyNotesPath(repoDir, filePath);
  if (!cls) return passthrough();

  // Route the read through the SINGLE guarded chokepoint every session-notes reader
  // uses (symlink / non-regular / oversize refusal BEFORE the bytes are loaded).
  let lineCount = NaN;
  try {
    const { readNotesFileGuarded } = require(
      path.join(__dirname, "lib", "session-notes-layout.js"),
    );
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(repoDir, filePath);
    const g = readNotesFileGuarded(abs);
    if (g.ok) lineCount = countLines(g.content);
  } catch {
    // fall through with NaN → suppress (an unavailable measurement is zero evidence)
  }

  const decision = decideCeilingAdvisory({ repoDir, filePath, lineCount });
  if (decision.action !== "advise") return passthrough();

  const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
  if (_timeout) clearTimeout(_timeout);
  emit({
    hookEvent,
    severity: "advisory",
    what_happened: `Session-notes artifact ${decision.rel} is ${decision.lineCount} lines — past the ${decision.ceiling}-line ceiling (target ${decision.target}).`,
    why: "session-notes-continuity.md MUST-3 — a no-truncate rule over an unbounded file only relocates the failure: the next reader must either violate MUST-2 or spend the context budget the work needed. Bounding is what makes the whole-read affordable.",
    agent_must_report: [
      `${decision.rel}: ${decision.lineCount} lines (ceiling ${decision.ceiling}, target ${decision.target})`,
      "Move the overflow into a NAMED file and leave an explicit pointer from the notes — not a silent truncation.",
    ],
    agent_must_wait:
      "Advisory — the write stands. Bound the artifact before the next session reads it.",
    user_summary: `session-notes-continuity MUST-3 — ${decision.rel} at ${decision.lineCount} lines exceeds the ${decision.ceiling}-line ceiling`,
  });
}

const READ_TOOLS = new Set(["Read"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function _main() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();

  let input = "";
  process.stdin.on("error", passthrough);
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(input || "{}");
      const toolName = payload.tool_name;
      const hookEvent = payload.hook_event_name || "PreToolUse";
      const repoDir =
        process.env.COC_OPERATOR_REPO_DIR ||
        process.env.CLAUDE_PROJECT_DIR ||
        (typeof payload.cwd === "string" && payload.cwd) ||
        process.cwd();

      if (READ_TOOLS.has(toolName)) return _readArm(payload, repoDir, hookEvent);
      if (WRITE_TOOLS.has(toolName)) return _writeArm(payload, repoDir, hookEvent);
      return passthrough();
    } catch {
      return passthrough();
    }
  });
}

if (require.main === module) {
  _main();
}

module.exports = {
  NOTES_TARGET_LINES,
  NOTES_CEILING_LINES,
  toRepoRel,
  classifyNotesPath,
  truncationOf,
  decideReadGate,
  countLines,
  decideCeilingAdvisory,
  markerPathFor,
  readRootNotesSeen,
  markRootNotesSeen,
};
