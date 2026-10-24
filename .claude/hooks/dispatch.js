#!/usr/bin/env node
/**
 * dispatch.js <Event> — the BOOTSTRAP of the hook dispatcher. settings.json runs
 * this file for every consolidated event; the dispatcher itself is
 * `lib/dispatch-main.js` (read its header for what a dispatch does).
 *
 * WHY THIS FILE IS SEPARATE, AND MUST STAY THIN (round-6 SEC MEDIUM-1). Every
 * event's guards run behind ONE dispatcher. A syntax error in it, or its deletion,
 * made node exit 1 before any handler was installed — at PreToolUse a NON-blocking
 * error, so every call ran with zero guards; at every other event every detector was
 * lost. Before consolidation one broken hook disabled one hook. (round-8 SEC HIGH-1:
 * that blast radius is also reached WITHOUT an error, by a body that loads, starts
 * and then answers nothing — see the completion record below.) So the dispatcher is
 * loaded HERE, inside try/catch, and if loading or starting it fails:
 *   - PreToolUse: REFUSED (exit 2 + a JSON deny naming the broken file and the
 *     repair), except the repair hatch below — NOT Read/Grep/Glob (S-C F1) — an exact
 *     `git checkout [HEAD|--ours] -- <file>` / `git restore [--source=HEAD] <file>` of a broken
 *     file — which is admitted LOUDLY (a non-JSON exit 1). NO Edit/Write of a hook
 *     file is admitted (round-7 SEC MEDIUM-1): the dispatcher body carries no content
 *     pin, so an admitted write of `module.exports={start(){process.exit(0)}}` would
 *     be every guard's off switch from the next call on. The restore commands take
 *     the content from git (the index, or HEAD), never from the call;
 *   - every other event: a loud non-JSON exit 1 (the host shows it to the user).
 * Either way stderr starts with the fixed line `[dispatch] BOOT-FAULT` (round-7 SEC LOW-4),
 * which validate-hooks.js grades an error whatever the exit code or error shape.
 * RULES FOR THIS FILE: node builtins ONLY — nothing under lib/ except the body it
 * exists to load (round-7 SEC LOW-2: a broken or hostile lib module on the fault
 * path made this file fail open) — no dispatch logic, edited only to change the
 * fault reply or the hatch. Everything else belongs in lib/dispatch-main.js. Any
 * throw while answering a fault is a refusal at PreToolUse (exit 2), loud elsewhere.
 *
 * ACCEPTED RESIDUAL: this file deleted or unparseable still fails OPEN — nothing in the
 * tree runs before it, so it is kept small and rarely edited (engine contract, Round-6:
 * workspaces/hook-consolidation-2026-09-26/02-plans/01-engine-contract.md).
 */
"use strict";

const t0 = require("perf_hooks").performance.now();
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const MAIN_REL = "hooks/lib/dispatch-main.js"; // relative to .claude/, like every hatch target
const BOOT_FAULT_MARKER = "[dispatch] BOOT-FAULT";
// The ONE stdin byte ceiling: this file's fault-path read AND the body's (lib/dispatch-main.js
// reads it from here — this file loads nothing from lib/). The Codex runtime's MAX_INPUT_BYTES.
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

// The mutation tools — INLINED (this file loads node builtins only). Equal to
// lib/tool-classes.js MUTATION_TOOLS, pinned by hook-engine.test.mjs so they cannot drift.
const MUTATION_TOOL_NAMES = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * `p` in canonical form: every EXISTING ancestor resolved through realpath, the
 * missing tail (which holds no symlink, since it does not exist) appended as is.
 * The final component itself is NOT followed — the file may be the broken one, and
 * a symlink at the target's name is not the target (a write lands where it points).
 * Null when the root will not resolve, or when a component EXISTS but will not (dangling
 * link, EACCES, ELOOP): it climbs only past a genuinely absent one, so null matches nothing
 * (train-8 R2 correctness ledger: the corr F1 class).
 *
 * INVARIANTS — held HERE, so the refusal never depends on a caller remembering them:
 *  - a raw `..` segment returns null: `path.resolve` collapses it LEXICALLY, before any symlink;
 *  - every CLIMBED component is one realpath reported ENOENT AND lstat cannot see — the
 *    flag is re-seeded per component and set only for an ENOENT lstat error, so a dangling
 *    link, EACCES or ELOOP refuses instead of climbing;
 *  - the check-to-use race is the ACCEPTED TOCTOU residual (rules/security.md § Path Containment).
 */
function canonPath(p) {
  if (typeof p === "string" && p.split(/[\\/]/).includes("..")) return null;
  let dir = path.dirname(path.resolve(p));
  const tail = [path.basename(path.resolve(p))];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch (e) {
      // Climb only past a GENUINELY absent component: realpath said ENOENT AND lstat finds
      // nothing there; exists-but-unresolvable (dangling link, EACCES, ELOOP) refuses.
      let absent = false;
      try { fs.lstatSync(dir); } catch (le) { absent = !!le && le.code === "ENOENT"; }
      if (!e || e.code !== "ENOENT" || !absent) return null;
      const up = path.dirname(dir);
      if (up === dir) return null;
      tail.unshift(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * The repair hatch — the ONE implementation (lib/dispatch-main.js delegates here).
 * Admits: read-only lookups; an exact one-line `git checkout [HEAD|--ours] -- <file>` /
 * `git restore [--source=HEAD] [--] <file>` of one of `files`; and — ONLY when
 * `opts.edit === true` — an Edit/Write/MultiEdit/NotebookEdit whose target is one of
 * `files`. The registry faults pass `edit: true` (the loom registry is content-pinned
 * by hash, so a write of it cannot switch a pinned session's guards off; the repo's
 * own local registry only ever switches the repo's own detectors); the bootstrap's
 * own fault never does (round-7 SEC MEDIUM-1). `files` are relative to
 * .claude/. A substring match over the whole tool input would let any call that
 * merely MENTIONS the file (a comment, an argument) run with zero guards. Any throw
 * here admits nothing. `opts.readOnly === false` closes the read-only half too: the
 * caller found a deny row that can refuse the lookup registered (S-C F1, ruling 9a — the
 * hatch admits a tool only where no deny row for it exists at the event).
 *
 * `--ours` is the restore of a path a conflicted landing left UNMERGED: there
 * `git checkout -- <file>` refuses ("path is unmerged"), and the conflict-marked
 * bytes are exactly what makes the guard unloadable. Stage #2 is the side being
 * landed ONTO (HEAD, in a merge and in a rebase/cherry-pick replay alike) — content
 * from git, never from the call; on a merged path it is the plain index restore.
 *
 * CONTAINMENT, BOTH SIDES RESOLVED (rules/security.md § Path Containment): a target
 * is kept only when its canonical form IS the resolved `.claude/` root joined with
 * the target's own lexical relative path. A symlinked ancestor anywhere between
 * `.claude/` and the file (e.g. `hooks/lib` → a directory outside the tree) moves
 * the canonical form off that join, so the target is dropped and nothing naming it
 * is admitted — the same refusal a symlink AT the target's name already earned.
 */
function repairHatch(payload, files, opts = {}) {
  try {
    return hatchAdmits(payload, files, opts || {}) === true;
  } catch {
    return false;
  }
}

function hatchAdmits(payload, files, opts) {
  const tool = payload && payload.tool_name;
  const input = (payload && payload.tool_input) || {};
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return opts.readOnly !== false;
  // The boundary, resolved through the SAME resolver as every candidate below; an
  // unresolvable boundary admits nothing (fail closed).
  let root;
  try {
    root = fs.realpathSync(path.join(HOOKS_DIR, ".."));
  } catch {
    return false;
  }
  const targets = [];
  for (const f of files || []) {
    // A target is a plain relative path under .claude/: no absolute path, no empty,
    // `.` or `..` segment — so the lexical join below names exactly one file.
    if (typeof f !== "string" || path.isAbsolute(f)) continue;
    const segs = f.split(/[\\/]/);
    if (segs.some((s) => s === "" || s === "." || s === "..")) continue;
    const raw = path.join(HOOKS_DIR, "..", f);
    // A target that is itself a symlink is not repaired by writing through it (the
    // write lands wherever it points) nor by a command naming it.
    try {
      if (fs.lstatSync(raw).isSymbolicLink()) continue;
    } catch {}
    const c = canonPath(raw);
    // A symlinked ANCESTOR re-routes the canonical form away from root + f: dropped.
    if (c !== null && c === path.join(root, ...segs)) targets.push(c);
  }
  if (targets.length === 0) return false;
  const matches = (p) => {
    const c = canonPath(p);
    return c !== null && targets.includes(c);
  };
  const cwd = (payload && typeof payload.cwd === "string" && payload.cwd) || path.resolve(HOOKS_DIR, "..", "..");
  if (typeof tool === "string" && MUTATION_TOOL_NAMES.includes(tool)) {
    if (opts.edit !== true) return false;
    const p = input.file_path || input.notebook_path;
    // A `..` segment is refused before resolving: path.resolve collapses it
    // LEXICALLY, before canonPath sees any symlink it would have crossed.
    if (typeof p !== "string" || p.split(/[\\/]/).includes("..")) return false;
    return matches(path.resolve(cwd, p));
  }
  if (tool === "Bash" && typeof input.command === "string") {
    // One line, spaces/tabs only: a newline (or any control character) would make
    // the shell run a SECOND command after the checkout.
    if (/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(input.command.replace(/\t/g, ""))) return false;
    // EXACTLY one restore of one path: the whole line is the command, anchored at
    // both ends, so a trailing word, `;`, `&&`, `||`, `|`, `&`, a redirection or a
    // second path leaves the match empty.
    const m = input.command.trim().match(/^git[ \t]+(?:checkout[ \t]+(?:(?:HEAD|--ours)[ \t]+)?--|restore(?:[ \t]+--source=HEAD)?(?:[ \t]+--)?)[ \t]+([^ \t]+)$/);
    // The token is what the SHELL will run, so it must be a plain path — no shell
    // syntax, no `..` segment, no leading `-` (an option where `git restore` without
    // `--` expects the path) — before its resolved form is compared at all.
    if (!m || !/^[A-Za-z0-9._\/-]+$/.test(m[1]) || m[1].startsWith("-") || m[1].split("/").includes("..")) return false;
    return matches(path.resolve(cwd, m[1]));
  }
  return false;
}

// Bounds on the two files the unmerged read below opens. MEASURED: loom's index is
// 2,064,727 B for 13,968 entries (v2) at 8c01b43ac; 64 MiB is ~32x that. A `.git`
// FILE (a linked worktree) is one `gitdir:` line.
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_GITFILE_BYTES = 4096;

/** A regular file's bytes, never blocking and never following a symlink; null past `max`. */
function readBounded(p, max) {
  const c = fs.constants;
  const fd = fs.openSync(p, c.O_RDONLY | (c.O_NONBLOCK || 0) | (c.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let n = 0;
    while (n < st.size) {
      const k = fs.readSync(fd, buf, n, st.size - n, null);
      if (k === 0) break;
      n += k;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Which of `rels` (repo-root-relative, `/`-separated) the index holds UNMERGED — at a
 * stage > 0, the state a conflicted merge/rebase/cherry-pick leaves — read from the
 * index file itself (formats 2-4), because this file spawns nothing and loads no lib.
 * Null when it cannot be told (no `.git`, an unreadable or unknown index): the caller
 * then names both restores rather than guess. Advice only — the hatch admits the
 * `--ours` restore either way, since its content comes from git, not from the call.
 * Lib code that needs the same answer reads it here, so the two cannot drift.
 */
function unmergedPaths(rels) {
  const repoRoot = path.resolve(HOOKS_DIR, "..", "..");
  const dot = path.join(repoRoot, ".git");
  let gitDir = null;
  if (fs.lstatSync(dot).isDirectory()) gitDir = dot;
  else {
    const b = readBounded(dot, MAX_GITFILE_BYTES);
    const m = b && /^gitdir:[ \t]*(\S.*?)[ \t\r]*$/m.exec(b.toString("utf8"));
    if (m) gitDir = path.resolve(repoRoot, m[1]);
  }
  if (gitDir === null) return null;
  const buf = readBounded(path.join(gitDir, "index"), MAX_INDEX_BYTES);
  if (!buf || buf.length < 12 || buf.toString("latin1", 0, 4) !== "DIRC") return null;
  const ver = buf.readUInt32BE(4);
  if (ver < 2 || ver > 4) return null;
  const want = new Map((rels || []).map((r) => [Buffer.from(r, "utf8").toString("latin1"), r]));
  const out = new Set();
  let off = 12;
  let prev = "";
  for (let i = 0, n = buf.readUInt32BE(8); i < n; i++) {
    if (off + 62 > buf.length) return null;
    const flags = buf.readUInt16BE(off + 60);
    const ext = ver >= 3 && (flags & 0x4000) !== 0 ? 2 : 0;
    let p = off + 62 + ext;
    let name;
    if (ver === 4) {
      // The prefix-strip count, git's offset varint (read-cache.c::decode_varint).
      if (p >= buf.length) return null;
      let c = buf[p++];
      let strip = c & 127;
      while (c & 128) {
        if (p >= buf.length || strip > 0xffffff) return null;
        c = buf[p++];
        strip = (strip + 1) * 128 + (c & 127);
      }
      const end = buf.indexOf(0, p);
      if (end < 0 || strip > prev.length) return null;
      name = prev.slice(0, prev.length - strip) + buf.toString("latin1", p, end);
      off = end + 1;
    } else {
      const end = buf.indexOf(0, p);
      if (end < 0) return null;
      name = buf.toString("latin1", p, end);
      off += (62 + ext + (end - p) + 8) & ~7; // read-cache.c::ondisk_cache_entry_size
    }
    // git keeps entries sorted by path: one out of order is a misread, not an answer.
    if (name < prev) return null;
    prev = name;
    if (((flags >> 12) & 3) !== 0 && want.has(name)) out.add(want.get(name));
  }
  // A well-read index ends in extensions (4-byte signature, 4-byte size) chaining
  // EXACTLY onto the hash trailer (SHA-1 20 bytes, SHA-256 32). Anything else means the
  // entries were mis-walked, so the answer above cannot be trusted.
  while (off !== buf.length - 20 && off !== buf.length - 32) {
    if (off + 8 > buf.length - 20) return null;
    off += 8 + buf.readUInt32BE(off + 4);
  }
  return out;
}

module.exports = { repairHatch, canonPath, unmergedPaths, MUTATION_TOOL_NAMES, BOOT_FAULT_MARKER, STDIN_MAX_BYTES };

/**
 * The file(s) the load fault names — lib/dispatch-main.js, plus any hooks file the
 * error locates. Containment (round-7 SEC LOW-1, rules/security.md § Path
 * Containment): the candidate AND the boundary are both resolved through realpath
 * before the decision, so a planted `.claude/hooks/x` → `.claude/` symlink cannot
 * make an error naming `hooks/x/settings.json` admit a repair of `settings.json`.
 * Unresolvable ⇒ not added.
 */
function brokenFiles(err) {
  const out = [MAIN_REL];
  let base;
  try {
    base = fs.realpathSync(path.join(HOOKS_DIR, "..")); // the boundary, resolved too
  } catch {
    return out;
  }
  const text = `${(err && err.stack) || ""}\n${(err && err.message) || ""}`;
  for (const m of [/^(\S+?\.js):\d+/m.exec(text), /Cannot find module '([^']+)'/.exec(text)]) {
    if (!m || !path.isAbsolute(m[1])) continue;
    const c = canonPath(m[1]);
    if (c === null) continue;
    const rel = path.relative(base, c).split(path.sep).join("/");
    if (rel.startsWith("hooks/") && !rel.split("/").includes("..") && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/** Loading or starting the dispatcher failed: answer the host without it. */
function bootFault(err) {
  const chunks = [];
  let done = false;
  let event = process.argv[2] || null;
  let timer = null;
  let bytes = 0;
  const exitWith = (stdout, stderr, code) => {
    completion.answered = true; // this reply IS the answer — the early exit observer stands down
    return process.stderr.write(stderr, () => process.stdout.write(stdout, () => process.exit(code)));
  };
  // The reply itself could not be built: exit 2 is a refusal at PreToolUse (and the
  // conservative answer when the event is unknown), a non-JSON exit 1 elsewhere.
  // Touches nothing of `err` — reading it may be what threw.
  const lastResort = () => {
    completion.answered = true; // the marker below IS the answer, such as it is
    const code = event && event !== "PreToolUse" ? 1 : 2;
    try {
      process.stderr.write(
        `${BOOT_FAULT_MARKER}\n[dispatch] the hook dispatcher could not be loaded (.claude/${MAIN_REL}) and the fault reply could not be built — NO detector ran for ${event || "this event"}.\n`,
        () => process.exit(code),
      );
    } catch {
      process.exit(code);
    }
  };
  const answerNow = () => {
    let payload = null;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {}
    if (!event && payload && typeof payload.hook_event_name === "string") event = payload.hook_event_name;
    const ev = event || "this event";
    const files = brokenFiles(err);
    const where = files.map((f) => `.claude/${f}`).join(", ");
    const detail = String((err && err.stack) || err).split("\n").slice(0, 6).join("\n");
    const msg = `the hook dispatcher could not be loaded (${where}) — NO detector registered for ${ev} ran on this call.\n${detail}\n`;
    // Only an event that is ABSENT takes the refusal below (this may be PreToolUse, and
    // lastResort reads the same condition the same way); a NAMED event that is not
    // PreToolUse is loud instead — the non-JSON exit 1 the header gives every other
    // event, since exit 2 is a refusal only where the host defines one.
    // S-C F1 (ruling 9a): a lookup is admitted only where no guard that can refuse it went
    // unrun, which this file cannot know (the body that reads the registry failed; a read
    // here was an unbounded open with no watchdog — a FIFO hung it, final delta HIGH). So
    // the read-only half is CLOSED; the restore commands below need no lookup.
    if ((event && event !== "PreToolUse") || repairHatch(payload, files, { readOnly: false })) return exitWith("", `${BOOT_FAULT_MARKER}\n[dispatch] ${msg}`, 1);
    // An UNMERGED path (a conflicted landing left its markers in the file) refuses the
    // plain index restore, so its line is the `--ours` one. Unknown ⇒ both are named.
    let unmerged = null;
    try {
      unmerged = unmergedPaths(files.map((f) => `.claude/${f}`));
    } catch {
      unmerged = null;
    }
    const restore = files
      .map((f) => (unmerged !== null && unmerged.has(`.claude/${f}`) ? `\`git checkout --ours -- .claude/${f}\` (it is UNMERGED)` : `\`git checkout -- .claude/${f}\``))
      .join(", ");
    const ifUnmerged = unmerged === null ? "; if git says a path is unmerged, `git checkout --ours -- <file>` restores the side being landed onto" : "";
    const reason =
      "STOP — Tool call blocked.\n\nWHAT HAPPENED: " + msg +
      "WHY: with the dispatcher unloadable no guard can run, so this call cannot be vetted. Refusing is the fail-closed disposition.\n\n" +
      "REPORT TO USER (do not skip any):\n  - The hook dispatcher is broken; quote the error above.\n" +
      `  - Repair it by restoring from git: ${restore} (or \`git restore --source=HEAD <file>\`)${ifUnmerged}. ` +
      "Only exactly those restore commands are allowed — not Read/Grep/Glob either, since with the dispatcher unloadable no " +
      "guard that could refuse them can run. An Edit/Write of a hook file is NOT: with no guard " +
      "running its content cannot be vetted, and the dispatcher body has no content pin. If the broken state is an edit worth " +
      "keeping, the user repairs it outside this session.\n";
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    return exitWith(JSON.stringify(deny) + "\n", `${BOOT_FAULT_MARKER}\n` + reason + "\n", 2);
  };
  const answer = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      answerNow();
    } catch {
      lastResort();
    }
  };
  // The payload names the tool (for the hatch); a host that never closes stdin is
  // still answered, and one that writes past the ONE ceiling (STDIN_MAX_BYTES) is
  // answered AT it, with nothing kept — no payload, so the hatch admits nothing.
  timer = setTimeout(answer, 3000);
  const s = process.stdin;
  if (!s || s.isTTY) return answer();
  s.on("data", (c) => {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    if (done) return;
    if ((bytes += b.length) > STDIN_MAX_BYTES) (chunks.length = 0), answer();
    else chunks.push(b);
  });
  s.on("end", answer);
  s.on("error", answer);
  return undefined;
}

/**
 * The COMPLETION RECORD a started body must hand back (round-8 SEC HIGH-1): `ran` is
 * required below, the moment start() returns; `emitted` at exit, by the early observer.
 * This hands the record over and catches SIGTERM/SIGINT. The rationale and its measured
 * limits: lib/dispatch-main.js::completion (moved there, verbatim, to hold this file thin).
 */
function watchEmission(rec) {
  completion.rec = rec;
  // SIGTERM/SIGINT are CATCHABLE and do NOT emit 'exit' — node's signal default ends
  // the image outright — so exit THROUGH the early observer: one fault reply, never a
  // second copy of it. SIGKILL and an abort-driven OOM are unclosable; the limit, and
  // exactly which events it leaves silent, are named in lib/dispatch-main.js::completion.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    try {
      process.on(sig, () => { if (rec.emitted !== true) process.exit(); });
    } catch {}
  }
}

/**
 * THE EARLY EXIT ANSWER (R2 M4), installed ONLY when this file is the main module and
 * BEFORE the body is required, so an exit with NO reply — at the body's load, inside
 * start(), before main()'s first await — is answered: no reply written and no emitted
 * record ⇒ PreToolUse (or an unknown/absent event) is REFUSED, exit 2 with the BOOT-FAULT
 * marker; a NAMED non-PreToolUse event stays loud, exit 1. A written reply returns at once,
 * its exit code untouched. Why: lib/dispatch-main.js::completion (moved there, verbatim).
 */
const completion = { rec: null, answered: false };
if (require.main === module) {
  process.on("exit", () => {
    try {
      if (completion.answered || (completion.rec && completion.rec.emitted === true)) return;
      // The record's event first, then argv — the fallback bootFault starts from.
      // An unknown or absent event takes the refusal.
      const ev = (completion.rec && typeof completion.rec.event === "string" && completion.rec.event) || process.argv[2] || null;
      try {
        fs.writeSync(2, `${BOOT_FAULT_MARKER}\n[dispatch] .claude/${MAIN_REL} answered nothing for ${ev || "this event"} — the process ended with no reply (an exit at load, inside start(), or before main()'s first await), so NO detector registered for ${ev || "this event"} ran on this call.\n`);
      } catch {}
      process.exitCode = ev && ev !== "PreToolUse" ? 1 : 2;
    } catch {}
  });
}

let dispatcher = null;
let loadError = null;
try {
  dispatcher = require("./lib/dispatch-main.js");
  if (!dispatcher || typeof dispatcher.start !== "function") throw new Error(`${MAIN_REL} exports no start()`);
} catch (e) {
  loadError = e;
}

if (require.main === module) {
  if (loadError) bootFault(loadError);
  else {
    let rec = null;
    let e0 = null;
    try {
      rec = dispatcher.start({ t0 });
    } catch (e) {
      e0 = e;
    }
    // A body that starts and answers NOTHING is the same fault as one that never
    // loaded (F1): refuse it, rather than let its silence read as an allow.
    if (e0 || !rec || typeof rec !== "object" || rec.ran !== true) bootFault(e0 || new Error(`${MAIN_REL} returned no completion record — it did not answer this event`));
    else watchEmission(rec);
  }
} else if (loadError) {
  throw loadError;
} else {
  module.exports.registryFaultReply = dispatcher.registryFaultReply;
}
