"use strict";
/**
 * shadow-feed — the REVIEW FEED a shadow registry row writes instead of blocking.
 *
 * Owner order (2026-10-14): the old guards stop BLOCKING and become a review feed
 * for the guard foundation; the data-loss arms keep enforcing. A registry row
 * declaring `enforcement: "shadow"` still runs, and when it reaches a verdict that
 * WOULD have refused the call, lib/dispatch-main.js passes the call through and
 * appends ONE line here (dispatch-main.js § SHADOW ROWS).
 *
 * THE LINE IS AN ALLOWLISTED STRUCTURE, NEVER FREE TEXT (R1 MED-2): ts, hook, event,
 * tool_name (capped), kind, decision (what the host would have done: deny, ask, halt or
 * block), rule_id (capped) and a short sha256 of the refusal text.
 * A guard's refusal routinely quotes the command, path or value it objected to, and no
 * blocklist redactor removes every shape of that (measured: backslash paths, bare
 * filenames, KEY=VALUE tokens, smart quotes all passed one), so the text itself is never
 * written. The hash lets a reviewer group identical refusals without reading them.
 *
 * THE WRITE IS THE SHARED SINK, NEVER A SECOND ONE (R1 HIGH-1): append-sink.js's
 * appendSinkLine refuses a FIFO without blocking (O_NONBLOCK), a symlinked or
 * hard-linked sink, and a sink outside the repo or its main checkout. A re-implemented
 * append stalled the dispatcher on a planted FIFO until the host killed it, dropping an
 * enforce row's deny in the same call.
 *
 * THE FEED IS BOUNDED: at MAX_FEED_BYTES the current file is renamed to `<feed>.1`
 * (replacing the previous generation) before the next line, so the feed never holds more
 * than FEED_BOUND_BYTES on disk. The rename only runs when the feed is a plain,
 * singly-linked file in a learning directory that resolves to its own checkout (the
 * rename is a path operation and must not move a file somewhere a link points); the
 * append that follows still goes through every append-sink check. Residual: a directory
 * swapped between that check and the rename moves one file named FEED_BASENAME.
 *
 * The feed lives under .claude/learning/ (gitignored: `.claude/learning/**`). Writing
 * it is best-effort: a failure is returned to the caller, which notes it; it never
 * turns a shadow row back into a refusal and never drops another row's verdict.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FEED_BASENAME = "guard-shadow-feed.jsonl";
const KINDS = Object.freeze(["verdict", "incomplete", "starved"]);
const DECISIONS = Object.freeze(["deny", "ask", "halt", "block"]);
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const FEED_GENERATIONS = 2; // the live file + one rotated `.1`
const FEED_BOUND_BYTES = MAX_FEED_BYTES * FEED_GENERATIONS;
const MAX_TOOL_CHARS = 64;
const MAX_RULE_CHARS = 80;
const REASON_HASH_CHARS = 12;
const RECORD_KEYS = Object.freeze(["ts", "hook", "event", "tool_name", "kind", "decision", "rule_id", "reason_sha256"]);

/** The feed path for a hooks dir: <repo>/.claude/learning/guard-shadow-feed.jsonl. */
function feedPath(hooksDir) {
  return path.join(hooksDir, "..", "learning", FEED_BASENAME);
}

const capped = (v, n) => (typeof v === "string" && v ? (v.length > n ? v.slice(0, n) : v) : null);

/** Build the feed record from the allowlisted fields only (pure). */
function shadowRecord({ hook, event, toolName, kind, decision, ruleId, reason, now = new Date() }) {
  return {
    ts: now.toISOString(),
    hook: capped(hook, 128) || "(unnamed row)",
    event: capped(event, 32) || "",
    tool_name: capped(toolName, MAX_TOOL_CHARS),
    kind: KINDS.includes(kind) ? kind : "verdict",
    decision: DECISIONS.includes(decision) ? decision : null,
    rule_id: capped(ruleId, MAX_RULE_CHARS),
    reason_sha256: typeof reason === "string" && reason ? crypto.createHash("sha256").update(reason).digest("hex").slice(0, REASON_HASH_CHARS) : null,
  };
}

/**
 * Rotate the feed when it has reached MAX_FEED_BYTES. Returns null, or why it did not
 * rotate when it should have; the caller then writes no line (the bound holds) and the
 * dispatcher notes it. A full feed is never a reason to restore a refusal.
 */
function rotateIfFull(fp, roots) {
  let st;
  try {
    st = fs.lstatSync(fp);
  } catch {
    return null; // absent: nothing to rotate
  }
  if (st.size < MAX_FEED_BYTES) return null;
  if (!st.isFile() || st.nlink !== 1) return "feed at the size bound is not a plain singly-linked file; not rotated";
  try {
    const realDir = fs.realpathSync(path.dirname(fp));
    const own = roots.some((r) => {
      try {
        return path.join(fs.realpathSync(r), ".claude", "learning") === realDir;
      } catch {
        return false;
      }
    });
    if (!own) return "feed directory does not resolve inside its checkout; not rotated";
    fs.renameSync(fp, `${fp}.1`);
    return null;
  } catch (e) {
    return `rotation failed: ${e && e.message ? e.message : String(e)}`;
  }
}

/**
 * Append ONE record through append-sink.js. Returns null on success, or the reason it
 * was not written (never throws).
 */
function appendShadowLine(hooksDir, record) {
  try {
    const sink = require("./append-sink.js");
    const repoDir = path.resolve(hooksDir, "..", "..");
    const additionalRoots = sink.mainCheckoutBoundaryRoots(repoDir);
    const fp = feedPath(hooksDir);
    // A feed at the bound that could not be rotated takes no more lines: the bound holds.
    const rotErr = rotateIfFull(fp, [repoDir, ...additionalRoots]);
    if (rotErr) return `feed at its ${MAX_FEED_BYTES}-byte bound: ${rotErr}`;
    const r = sink.appendSinkLine({ repoDir, additionalRoots, sinkPath: fp, line: JSON.stringify(record) });
    return r && r.ok ? null : `${(r && r.error) || "append failed"}: ${(r && r.reason) || "no reason given"}`;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

module.exports = { FEED_BASENAME, KINDS, DECISIONS, RECORD_KEYS, MAX_FEED_BYTES, FEED_BOUND_BYTES, feedPath, shadowRecord, appendShadowLine };
