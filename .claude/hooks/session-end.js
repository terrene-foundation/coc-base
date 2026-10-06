#!/usr/bin/env node
/**
 * @hook-event: SessionEnd (lifecycle) — completed session observations and workspace state exist for resumption-state capture.
 *
 * Hook: session-end
 * Event: SessionEnd
 * Purpose: Save session state for future resumption
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const path = require("path");
const {
  resolveLearningDir,
  ensureLearningDir,
  logObservation: logLearningObservation,
  countObservations,
} = require("./lib/learning-utils");
const { classifyCommitForJournal } = require("./lib/journal-classifier");
// loom#1349 — the ONE hardened append primitive; see lib/append-sink.js for the six defenses.
const { appendSinkLine } = require("./lib/append-sink.js");
// The single guarded-read chokepoint for tracked/shared session-notes paths
// (R9 MED-1): lstat-refuses symlink/non-regular + size-caps BEFORE reading, so a
// teammate-plantable `.session-notes` (-> /dev/zero, or oversized) cannot hang/OOM
// this SessionEnd hook. Returns { ok, content, stat } — stat carries mtime for the
// age gate without a second (un-guarded) statSync.
const { readNotesFileGuarded } = require("./lib/session-notes-layout.js");
// The hardened create primitive `state-io.js::_writeFileHardened` (exported as `writeFileHardened`;
// O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) — `lib/state-io.js:255-371`. See writeSessionFileAtomic below.
const { writeFileHardened } = require("./lib/state-io");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 15000;
// Armed by hookMain(), not at load: require() of this file has no side effects,
// so the in-process hook engine can load it once per worker and run it per event.
let _timeout = null;

function hookMain() {
  _timeout = setTimeout(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      try {
        onStdinEnd(input);
      } catch (e) {
        return reject(e);
      }
      resolve();
    });
  });
}

// In-engine, process.exit() throws a sentinel, so the catch below also runs after
// the success exit; it only writes (discarded once the detector has ended) and
// exits (the first recorded code stands) — no state change can happen there.
function onStdinEnd(input) {
  try {
    const data = JSON.parse(input);
    // MEASURED BEFORE `saveSession`, and the ordering is load-bearing: that call
    // calls `ensureLearningDir(cwd)`, which CREATES `.claude/learning/` in the
    // session's cwd. Taking the reading afterwards would report the hook's own
    // write as the session's loose scratch in any repo where `.claude/` is
    // neither tracked nor ignored — an instrument measuring its own footprint.
    // Fail-open in its own try/catch: an advisory must never change the
    // checkpoint's outcome.
    let loose = null;
    try {
      loose = looseScratchLine(data.cwd);
    } catch {
      /* fail open — silence is the correct failure mode for an advisory */
    }
    const { summary, refused } = saveSession(data);
    // SessionEnd schema: no hookSpecificOutput. Surface a stderr summary so
    // the user sees what was checkpointed (was DARK pre-fix).
    if (summary) {
      process.stderr.write(`[session-end] ${summary}\n`);
    }
    // `conservation-gate.md` MUST-5 (its durable-root sentence), carried
    // mechanically at the one moment it is still cheap to act on (read above,
    // before the checkpoint moved the tree).
    if (loose) process.stderr.write(`[session-end] ${loose}\n`);
    // A refused ~/.claude/sessions is the ONE outcome reported as a failure: at
    // SessionEnd the host prints nothing a hook says unless the hook FAILED
    // (non-zero exit), and then it prints that hook's stderr — the one line
    // above. No JSON on stdout, so it reads as a plain non-blocking failure.
    // Exit 1, never 2: 2 means "blocked" there, and nothing is being blocked.
    if (refused) process.exit(1);
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[session-end] HOOK ERROR: ${error.message}\n`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
}

/**
 * Loose scratch in the tracked tree — the mechanically-decidable half of
 * `rules/conservation-gate.md` MUST-5 — "scratch that must outlive the session
 * MUST go in a repo-declared gitignored path, never loose in the tracked tree".
 *
 * Reads `git status --porcelain` `??` entries: untracked AND not ignored. That
 * is a parsed structural fact, not a token match — the class
 * `rules/hook-output-discipline.md` MUST-2 names in its own worked examples. It
 * is ADVISORY regardless: at SessionEnd there is nothing left to block, and a
 * session ending with a DELIBERATE untracked artifact must not be refused.
 *
 * NOT a `/tmp` detector. The rule's `MUST NOT` forbids one: the discriminator for
 * a SPELLED path is a lifetime/ownership question about the path's TARGET, which
 * no tool-call-time signal can observe. What IS observable is whether a path is
 * loose in the tree at all.
 *
 * WHAT IT CANNOT SEE, so its silence is not read as coverage: a file under a
 * DECLARED gitignored root (`scratchpad/`, `.claude/.scratch/`, `.claude/worktrees/`)
 * is what the rule ASKS for and is invisible here by construction. This reports
 * the rule's violation, never its compliance.
 *
 * `--no-optional-locks` is load-bearing: this is a READ in a possibly SHARED
 * checkout (the primary may be mid-landing), and it must not take `index.lock`.
 * Returns a one-line report, or null — and null covers BOTH "nothing loose" and
 * "could not measure", which is why the caller adds no claim of its own.
 */
function looseScratchLine(cwd) {
  if (!cwd) return null;
  let bin;
  let env;
  let execFileSync;
  try {
    // Lazy, matching this file's existing pattern (see the `child_process`
    // require further down) so a require() of this module stays side-effect free.
    ({ execFileSync } = require("child_process"));
    const {
      resolveGitBinary,
      gitEnvForArgs,
    } = require("./lib/git-subprocess-env.js");
    bin = resolveGitBinary();
    env = gitEnvForArgs
      ? gitEnvForArgs(["--no-optional-locks", "status"])
      : undefined;
  } catch {
    return null;
  }
  try {
    const out = execFileSync(
      bin,
      [
        "--no-optional-locks",
        "status",
        "--porcelain",
        "-z",
        "--untracked-files=normal",
      ],
      { cwd, encoding: "utf8", timeout: 2500, maxBuffer: 4 * 1024 * 1024, env },
    );
    // `-z` is NUL-delimited and, unlike the newline form, never C-QUOTES a path,
    // so a name with a space or a non-ASCII byte arrives verbatim.
    const paths = out
      .split("\0")
      .filter((e) => e.startsWith("?? "))
      .map((e) => e.slice(3))
      .sort();
    if (!paths.length) return null;
    const LISTED = 10;
    const shown = paths.slice(0, LISTED).join(", ");
    return (
      `${paths.length} untracked path(s) are loose in the tracked tree ` +
      `(conservation-gate.md MUST-5 — scratch belongs under a ` +
      `declared-gitignored root): ${shown}` +
      (paths.length > LISTED ? ` … and ${paths.length - LISTED} more` : "")
    );
  } catch {
    return null;
  }
}

function saveSession(data) {
  // Sanitize session_id to prevent path traversal
  const session_id = (data.session_id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cwd = data.cwd;
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  // Creates the directory as before, then refuses it unless it resolves to
  // <realpath ~/.claude>/sessions — see resolveSessionsDir.
  const sessions = resolveSessionsDir(homeDir);
  const sessionDir = sessions.dir;
  const learningDir = resolveLearningDir(cwd);
  ensureLearningDir(cwd);

  // The session's recorded start (written by session-start.js). Read HERE,
  // before the rewrite below: that rewrite replaces the file, so every reader
  // that used to open it afterwards saw no `startedAt` and fell back. A
  // refused sessions dir is never read: the start is unknown.
  const sessionStartMs = sessions.ok
    ? readSessionStartMs(
        path.join(sessionDir, `${session_id}.json`),
        Date.now(),
      )
    : null;

  // Collect session statistics
  const sessionData = {
    session_id,
    cwd,
    endedAt: new Date().toISOString(),
    stats: collectSessionStats(cwd),
  };

  try {
    if (sessions.ok) {
      // Save to session-specific file
      const sessionFile = path.join(sessionDir, `${session_id}.json`);
      writeSessionFileAtomic(sessionFile, JSON.stringify(sessionData, null, 2));

      // Save as last session for quick resume
      const lastSessionFile = path.join(sessionDir, "last-session.json");
      writeSessionFileAtomic(
        lastSessionFile,
        JSON.stringify(sessionData, null, 2),
      );
    }

    // Log enriched session_summary observation for learning
    logLearningObservation(
      cwd,
      "session_summary",
      {
        file_counts: sessionData.stats,
        framework: detectFramework(cwd),
        duration_estimate: estimateSessionDuration(sessionStartMs),
      },
      {
        session_id,
      },
    );

    // --- Log session accomplishments from .session-notes ---
    try {
      logSessionAccomplishments(cwd, session_id);
    } catch {}

    // --- Log journal decisions created this session ---
    try {
      logDecisionReferences(cwd, session_id, sessionStartMs);
    } catch {}

    // --- Generate journal candidates from commits (Option B automation) ---
    try {
      generateJournalCandidates(cwd, session_id, sessionStartMs);
    } catch {}

    // --- Build learning digest (replaces instinct pipeline) ---
    // buildLearningDigest never throws; it returns its own verdict, which the
    // summary below reports verbatim rather than assuming success.
    const digestVerdict = buildLearningDigest(cwd, learningDir);

    // Clean up old sessions (keep last 20) — only inside a verified dir.
    if (sessions.ok) cleanupOldSessions(sessionDir, 20);

    // User-visible summary (was DARK before; mitigates red-team session-end-DARK)
    const stats = sessionData.stats || {};
    const fileCount = Object.values(stats).reduce(
      (a, b) => a + (typeof b === "number" ? b : 0),
      0,
    );
    const digestNote =
      digestVerdict === "built"
        ? "learning digest built"
        : digestVerdict === "skipped-below-threshold"
          ? "learning digest skipped (below observation threshold)"
          : "learning digest unavailable";
    // The ONE stderr line for a refused sessions dir: it names the path, and it
    // replaces "checkpoint saved", which would claim a write that did not happen.
    if (!sessions.ok) {
      return {
        summary: `checkpoint NOT saved: ${sessions.dir} REFUSED (${sessions.why}) — nothing read, written or cleaned up there (session=${session_id.slice(0, 8)}, ~${fileCount} touched, ${digestNote})`,
        refused: true,
      };
    }
    return {
      summary: `checkpoint saved (session=${session_id.slice(0, 8)}, ~${fileCount} touched, ${digestNote})`,
      refused: false,
    };
  } catch (error) {
    // A refused dir stays a failure even when a later step threw: the refusal is
    // the one thing the host must be made to print.
    return sessions.ok
      ? { summary: `checkpoint FAILED: ${error.message}`, refused: false }
      : {
          summary: `checkpoint NOT saved: ${sessions.dir} REFUSED (${sessions.why}) — nothing read, written or cleaned up there; then FAILED: ${error.message}`,
          refused: true,
        };
  }
}

// Scans top-level cwd only (not subdirectories) for performance in hooks.
function collectSessionStats(cwd) {
  try {
    const stats = {
      pythonFiles: 0,
      testFiles: 0,
      workflowFiles: 0,
    };

    const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));
    stats.pythonFiles = files.length;

    for (const file of files) {
      if (/_test\.py$|test_.*\.py$/.test(file)) {
        stats.testFiles++;
      }
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/WorkflowBuilder/.test(content)) {
          stats.workflowFiles++;
        }
      } catch {}
    }

    return stats;
  } catch {
    return {};
  }
}

// Scans top-level cwd only (not subdirectories) for performance in hooks.
function detectFramework(cwd) {
  try {
    const files = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));
    for (const file of files.slice(0, 10)) {
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/@db\.model/.test(content) || /from dataflow/.test(content))
          return "dataflow";
        if (/from nexus/.test(content) || /Nexus\(/.test(content))
          return "nexus";
        if (/from kaizen/.test(content) || /BaseAgent/.test(content))
          return "kaizen";
        if (/WorkflowBuilder/.test(content)) return "core-sdk";
      } catch {}
    }
    return "core-sdk";
  } catch {
    return "unknown";
  }
}

// The only accepted `startedAt` shape: exactly what Date#toISOString emits.
// Mirror of session-start.js (the writer); session-start-end-startedat.test.mjs
// pins the two copies to the same verdicts.
const STARTED_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A recorded session start, as epoch ms — or null when the value is absent,
 * not a string, not the toISOString shape, not a real calendar instant, or in
 * the FUTURE relative to `nowMs`. Null means "unknown start": every consumer
 * keeps its pre-existing fallback.
 */
function parseSessionStartedAt(value, nowMs) {
  if (typeof value !== "string" || !STARTED_AT_SHAPE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null;
  if (ms > nowMs) return null;
  return ms;
}

// ── readSessionFile + resolveSessionsDir: MIRRORED byte-for-byte in
// session-start.js; session-start-end-startedat.test.mjs (S13) pins the two
// copies to the same verdicts. Mirrored rather than required across hooks so
// neither hook fails to LOAD in a tree that ships only one of them.

/**
 * A session file's JSON, read from ONE descriptor — never a path-based check
 * followed by a path-based read, which a swap between the two defeats (a FIFO
 * swapped in blocks the reader; a symlink swapped in is read through).
 * O_NOFOLLOW refuses a link at the final component, O_NONBLOCK keeps a FIFO
 * from blocking the open, and the regular-file check is made on the OPEN fd.
 *   { kind: "absent" }       ENOENT
 *   { kind: "not-regular" }  a symlink (ELOOP/EMLINK) or a non-regular fd
 *   { kind: "unopenable" }   any other open failure (EACCES, ENXIO, …)
 *   { kind: "corrupt" }      a regular file that did not read / parse
 *   { kind: "ok", data }     the parsed JSON value
 */
function readSessionFile(file) {
  const c = fs.constants;
  let fd;
  try {
    fd = fs.openSync(
      file,
      c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0),
    );
  } catch (e) {
    if (e && e.code === "ENOENT") return { kind: "absent" };
    if (e && (e.code === "ELOOP" || e.code === "EMLINK"))
      return { kind: "not-regular" };
    return { kind: "unopenable" };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "not-regular" };
    return { kind: "ok", data: JSON.parse(fs.readFileSync(fd, "utf8")) };
  } catch {
    return { kind: "corrupt" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

/**
 * ~/.claude/sessions, created as before and then CONTAINED (rules/security.md
 * § Path Containment): both sides go through the same resolver, and the dir is
 * accepted only when realpath(<home>/.claude/sessions) equals
 * realpath(<home>/.claude) + "/sessions". So a symlinked ~/.claude (dotfiles)
 * still works, while a `sessions` link to another directory — where the hooks
 * would write, and session-end's cleanup would unlink every *.json but the
 * newest 20 — is refused, as is a dir that will not resolve (fail closed).
 * Returns { ok, dir, why } — `dir` is the lexical path, `why` set when !ok.
 */
function resolveSessionsDir(homeDir) {
  const claudeDir = path.join(homeDir, ".claude");
  const dir = path.join(claudeDir, "sessions");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  let real;
  let expected;
  try {
    real = fs.realpathSync(dir);
    expected = path.join(fs.realpathSync(claudeDir), "sessions");
  } catch (e) {
    return { ok: false, dir, why: `does not resolve: ${(e && e.code) || e}` };
  }
  if (real !== expected) {
    return { ok: false, dir, why: `resolves to ${real}, not ${expected}` };
  }
  return { ok: true, dir, why: null };
}

/** `startedAt` from a session file; missing / unreadable / corrupt / invalid ⇒ null. */
function readSessionStartMs(sessionFile, nowMs) {
  // A symlink planted at the session file is not read through, and a FIFO
  // there cannot stall the hook until its fallback timer (it reads as absent).
  const r = readSessionFile(sessionFile);
  if (r.kind !== "ok") return null;
  return r.data && typeof r.data === "object"
    ? parseSessionStartedAt(r.data.startedAt, nowMs)
    : null;
}

/**
 * Write `content` to `file` under ~/.claude/sessions without following a
 * planted link. A plain `writeFileSync(file)` opened a symlink at `file` and
 * wrote THROUGH it, into whatever it pointed at. Instead: create a pid-scoped
 * tmp via `writeFileHardened` (O_EXCL|O_NOFOLLOW, 0600 — refuses a symlink,
 * hard link or directory at the tmp path, leaving it in place), then `rename`
 * over `file` — rename replaces a symlink at the final path as a directory
 * entry and never writes into its target. A refusal throws into saveSession's
 * existing one-line "checkpoint FAILED" path.
 */
function writeSessionFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  const wrote = writeFileHardened(tmp, content, { replaceExisting: true });
  if (!wrote.ok) throw new Error(`tmp write refused: ${wrote.reason}`);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function estimateSessionDuration(sessionStartMs) {
  if (sessionStartMs === null) return null;
  return Math.round((Date.now() - sessionStartMs) / 1000); // seconds
}

/**
 * Log session accomplishments from .session-notes file.
 * Parses the "Accomplished" or "Completed" section if it exists.
 */
function logSessionAccomplishments(cwd, sessionId) {
  // Check multiple possible locations for session notes
  const candidates = [
    path.join(cwd, ".session-notes"),
    path.join(cwd, "workspaces"),
  ];

  // Direct .session-notes file
  const notesPath = candidates[0];
  if (fs.existsSync(notesPath)) {
    // Guarded read (R9 MED-1): a symlink/oversize root .session-notes is skipped,
    // never read into a hang. Root notes present → handle here, do not also scan
    // workspaces (preserves the original control flow).
    const g = readNotesFileGuarded(notesPath);
    if (g.ok) {
      const ageHours = (Date.now() - g.stat.mtimeMs) / (1000 * 60 * 60);
      // Only log if modified recently (within last 4 hours = likely this session)
      if (ageHours <= 4) {
        const accomplishments = extractAccomplishments(g.content);
        if (accomplishments) {
          logLearningObservation(
            cwd,
            "session_accomplishment",
            { accomplishments: accomplishments.substring(0, 1000) },
            { session_id: sessionId },
          );
        }
      }
    }
    return;
  }

  // Check workspace session notes
  const wsDir = candidates[1];
  if (!fs.existsSync(wsDir)) return;

  try {
    const workspaces = fs.readdirSync(wsDir);
    for (const ws of workspaces) {
      const wsNotes = path.join(wsDir, ws, ".session-notes");
      // Guarded read (R9 MED-1): workspaces/<ws>/.session-notes is a live
      // committed multi-operator surface with a genuine teammate-symlink vector;
      // absent/symlink/oversize → skip this workspace, never hang.
      const g = readNotesFileGuarded(wsNotes);
      if (!g.ok) continue;
      const ageHours = (Date.now() - g.stat.mtimeMs) / (1000 * 60 * 60);
      if (ageHours > 4) continue;

      const content = g.content;
      const accomplishments = extractAccomplishments(content);
      if (accomplishments) {
        logLearningObservation(
          cwd,
          "session_accomplishment",
          {
            workspace: ws,
            accomplishments: accomplishments.substring(0, 1000),
          },
          { session_id: sessionId },
        );
      }
    }
  } catch {}
}

/**
 * Extract the "Accomplished" section from session notes markdown.
 */
function extractAccomplishments(content) {
  // Match ## Accomplished, ### Accomplished, or similar headings
  const match = content.match(
    /^#{1,4}\s*(?:Accomplished|Completed|Done|What was done)\s*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\Z)/im,
  );
  if (match && match[1].trim().length > 0) {
    return match[1].trim();
  }
  return null;
}

/**
 * Log journal entries created during this session as decision references.
 */
function logDecisionReferences(cwd, sessionId, recordedStartMs) {
  const journalDir = path.join(cwd, "journal");
  if (!fs.existsSync(journalDir)) return;

  // Session start time; unknown ⇒ default: 4 hours ago
  const sessionStartMs =
    recordedStartMs !== null
      ? recordedStartMs
      : Date.now() - 4 * 60 * 60 * 1000;

  try {
    const entries = fs.readdirSync(journalDir).filter((f) => f.endsWith(".md"));
    for (const entry of entries) {
      const entryPath = path.join(journalDir, entry);
      const stat = fs.statSync(entryPath);
      // Only log entries created/modified during this session
      if (stat.mtimeMs < sessionStartMs) continue;

      // Parse TYPE from filename. Handles BOTH the legacy single-operator
      // shape (NNNN-TYPE-topic.md) AND the multi-operator shape
      // (NNNN-<display_id>-TYPE-topic.md per knowledge-convergence.md MUST-2 /
      // rules/journal.md). The optional lowercase display_id segment is skipped
      // so TYPE (uppercase, may contain a hyphen e.g. TRADE-OFF) is captured,
      // not the display_id. Pre-multi-op regex `^\d+-(\w+)-` mis-captured the
      // display_id as the type for every NNNN-<display_id>-TYPE entry.
      const match = entry.match(
        /^\d+-(?:[a-z0-9_-]+-)?(DECISION|DISCOVERY|TRADE-OFF|RISK|CONNECTION|GAP|AMENDMENT)-(.+)\.md$/,
      );
      if (!match) continue;

      logLearningObservation(
        cwd,
        "decision_reference",
        {
          type: match[1], // DECISION, DISCOVERY, TRADE-OFF, RISK, CONNECTION, GAP, AMENDMENT
          topic: match[2].replace(/-/g, " "),
          file: entry,
        },
        { session_id: sessionId },
      );
    }
  } catch {}
}

/**
 * Build learning digest from observations.
 * Produces learning-digest.json — a structured summary consumed by /codify.
 * Pure file I/O, no LLM calls. Semantic analysis happens in /codify.
 */
// Returns one of: "built" | "skipped-below-threshold" | "unavailable".
// NEVER throws, and NEVER reports "built" for work it did not do — the caller
// puts this verdict in the user-visible summary, so a bare `catch {}` here
// silently converts a total failure into a success claim (the exact shape
// `zero-tolerance.md` Rule 3 blocks).
function buildLearningDigest(cwd, learningDir) {
  const observationCount = countObservations(learningDir);
  if (observationCount < 5) return "skipped-below-threshold";

  try {
    // Repo-root `scripts/`, NOT `.claude/learning/` — the prior specifier
    // ("../learning/digest-builder") named a directory that exists nowhere in
    // the corpus, so this require threw MODULE_NOT_FOUND on EVERY invocation.
    const digestBuilder = require("../../scripts/learning/digest-builder");
    digestBuilder.buildDigest(cwd, learningDir);
    return "built";
  } catch (error) {
    // Expected on any CONSUMER: repo-root `scripts/` is outside
    // `sync-tier-aware.mjs::walkClaudeDir()`, so the builder is never
    // distributed. Degrade honestly rather than swallowing — the caller
    // reports "digest unavailable", not "digest built".
    if (process.env.COC_HOOK_DEBUG) {
      console.error(
        `[session-end] learning digest unavailable: ${error && error.message}`,
      );
    }
    return "unavailable";
  }
}

/**
 * Generate journal candidate stubs from this session's commits.
 *
 * For each commit made during the session, classify via literal pattern
 * matching (no semantic analysis — hook-legal per cc-artifacts rule) and
 * write a stub to `workspaces/<project>/journal/.pending/`. The next session
 * reviews candidates, promotes the valuable ones to real journal entries,
 * and deletes the rest.
 *
 * Budget: single git log call, hard timeout 3s, capped at 30 commits.
 * Silent failure: if not a git repo, no workspace, or git fails, returns 0 candidates.
 */
function generateJournalCandidates(cwd, sessionId, recordedStartMs) {
  const { detectActiveWorkspace } = require("./lib/workspace-utils");
  const { execFileSync } = require("child_process");
  const { resolveGitBinary, gitEnv } = require("./lib/git-subprocess-env.js");

  const workspace = detectActiveWorkspace(cwd);
  if (!workspace) return;

  // Determine session start time for git log --since filter.
  //
  // PARSED, not passed through (loom#1471). `startedAt` used to be assigned
  // verbatim and then interpolated into a SHELL command string, inside double
  // quotes, unescaped — so a session JSON carrying
  // `x"; <command>; echo "` executed <command>. The file is
  // ~/.claude/sessions/<id>.json, which is the same delivery surface #1429 and
  // #1309 already treat as in-model: an agent able to Write settings.local.json
  // is equally able to Write this. Measured: the payload ran even though git
  // itself then errored, so git's exit status was never a barrier.
  //
  // The value now arrives already parsed (`readSessionStartMs`, read once in
  // `saveSession` before the session file is rewritten): it is accepted only as
  // a real, non-future instant in toISOString shape, and is re-serialised from
  // the parsed number so what reaches git is git's own format rather than
  // attacker-chosen bytes.
  const sessionStartIso = new Date(
    recordedStartMs !== null
      ? recordedStartMs
      : Date.now() - 4 * 60 * 60 * 1000,
  ).toISOString();

  // Fetch all session commits in one call. Use %x1f (unit sep) between fields
  // and %x1e (record sep) between commits so multi-line bodies parse safely.
  //
  // ARG ARRAY + fenced env, no shell: `--since=` is one argv element, so even a
  // value that survived the parse above cannot become syntax. The absolute
  // binary + constants-built env is the ordinary #1462/#1471 half.
  let rawLog;
  try {
    const gitBin = resolveGitBinary();
    if (!gitBin) return; // git unresolvable — no candidates, same as no commits
    rawLog = execFileSync(
      gitBin,
      [
        "log",
        `--since=${sessionStartIso}`,
        "--format=%H%x1f%s%x1f%b%x1e",
        "-n",
        "30",
      ],
      // stderr discarded here rather than by a `2>/dev/null` the shell used to
      // interpret — there is no shell now.
      {
        cwd,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
  } catch {
    return; // not a git repo, git failed, or no commits
  }
  if (!rawLog.trim()) return;

  const pendingDir = path.join(workspace.path, "journal", ".pending");
  try {
    fs.mkdirSync(pendingDir, { recursive: true });
  } catch {
    return;
  }

  const commits = rawLog.split("\x1e").filter((c) => c.trim());
  let count = 0;

  // De-dupe against commits already captured as pending stubs in ANY workspace.
  // Overlapping `--since` windows (esp. the now-4h fallback) otherwise re-capture
  // the same SHA every session, inflating the /codify pending backlog. See
  // lib/pending-dedup.js for the full failure-mode note.
  const { collectExistingPendingShas } = require("./lib/pending-dedup");
  const alreadyCaptured = collectExistingPendingShas(cwd);

  for (const commit of commits) {
    const parts = commit.trim().split("\x1f");
    const hash = parts[0];
    const subject = parts[1];
    const body = parts[2];
    if (!hash || !subject) continue;

    // Already captured (this workspace or another) — skip, log for audit parity
    // with the classifier-skip path so a future audit sees why nothing was written.
    if (alreadyCaptured.has(hash)) {
      appendJournalSkipLog(workspace.path, hash, "already-captured", subject);
      continue;
    }

    const verdict = classifyCommitForJournal(subject, body || "");
    if (!verdict.type) {
      // Per issue #114 acceptance criteria: log skipped commits to a
      // per-workspace .journal-skipped.log so a future audit can verify
      // nothing valuable was filtered. Single-line, grep-able shape.
      appendJournalSkipLog(workspace.path, hash, verdict.skipReason, subject);
      continue;
    }
    const type = verdict.type;

    const filename = `${Date.now()}-${count}-${type}.md`;
    const filepath = path.join(pendingDir, filename);

    const bodySection =
      body && body.trim() ? `\n**Body**:\n\n${body.trim()}\n` : "";
    const stub = `---
type: ${type}
status: pending
source_commit: ${hash}
session_id: ${sessionId}
created: ${new Date().toISOString()}
---

# ${subject}

<!-- Generated by SessionEnd hook from a commit matching a journal-worthy pattern.
     Next session: review, then promote to a real journal entry OR delete. -->

**Commit**: \`${hash.substring(0, 12)}\` — ${subject}
${bodySection}
## Context to fill in (memory-based, no verification tool calls)

- Why was this change made? What alternative was considered?
- What does it unlock or block for the next session?
- Is this worth a full journal entry, or is the commit message sufficient?

**Promote**: rename to \`journal/NNNN-${type}-slug.md\`, fill in context, remove the pending frontmatter.
**Discard**: \`rm\` this file.
`;

    try {
      fs.writeFileSync(filepath, stub);
      alreadyCaptured.add(hash); // keep the set authoritative for the rest of the loop
      count++;
    } catch {}
  }
}

/**
 * Append one line to the workspace's .journal-skipped.log.
 *
 * Format (per issue #114 acceptance criteria):
 *   <journal-skip>commit=SHA12 reason=SLUG subject="SUBJECT"</journal-skip>\n
 *
 * Best-effort write — never throws. The log is gitignored
 * (workspaces/* is gitignored at the repo root).
 */
function appendJournalSkipLog(workspacePath, hash, skipReason, subject) {
  try {
    const logPath = path.join(workspacePath, ".journal-skipped.log");
    const ts = new Date().toISOString();
    const safeSubject = String(subject || "")
      .replace(/[\r\n]/g, " ")
      .slice(0, 200);
    // loom#1349 R1 F3 — routed through the shared hardened primitive. Not JSONL, but the same
    // sink class: an append into a predictable path under a workspace directory, previously
    // following a planted symlink and creating world-readable. `workspacePath` is the
    // containment boundary here (the log lives directly inside it).
    const line = `${ts} <journal-skip>commit=${hash.slice(0, 12)} reason=${skipReason} subject="${safeSubject}"</journal-skip>`;
    appendSinkLine({ repoDir: workspacePath, sinkPath: logPath, line });
  } catch {}
}

// The sessions dir is SHARED with Claude Code, which registers every LIVE
// session there as `<pid>.json` (plus `<pid>.<hash>.key`) for cross-session
// discovery. This hook may prune ONLY the records it writes itself —
// `<session-uuid>.json` — never another session's registration.
const OWN_SESSION_RECORD =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;

// Called only with a dir resolveSessionsDir verified. Only REGULAR files are
// candidates (lstat, never following): a symlink, directory or FIFO named
// *.json is neither counted nor unlinked.
function cleanupOldSessions(sessionDir, keepCount) {
  try {
    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => OWN_SESSION_RECORD.test(f))
      .map((f) => {
        const p = path.join(sessionDir, f);
        let st = null;
        try {
          st = fs.lstatSync(p);
        } catch {}
        return st && st.isFile() ? { name: f, path: p, mtime: st.mtime } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    // Remove files beyond keepCount
    for (const file of files.slice(keepCount)) {
      try {
        fs.unlinkSync(file.path);
      } catch {}
    }
  } catch {}
}

module.exports = {
  hookMain,
  parseSessionStartedAt,
  readSessionFile,
  readSessionStartMs,
  resolveSessionsDir,
  cleanupOldSessions,
  writeSessionFileAtomic,
  // Exported so a fixture reads the DELETION BOUNDARY from the shipped module rather
  // than re-typing it: a transcribed copy would drift from the predicate it claims to
  // describe, and the pole would then pass against a pattern the hook does not use.
  OWN_SESSION_RECORD,
};

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
