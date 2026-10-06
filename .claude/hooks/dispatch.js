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
 *     repair), except the repair hatch below — Read/Grep/Glob, and an exact
 *     `git checkout -- <file>` / `git restore [--source=HEAD] <file>` of a broken
 *     file — which is admitted LOUDLY (a non-JSON exit 1). NO Edit/Write of a hook
 *     file is admitted (round-7 SEC MEDIUM-1): the dispatcher body carries no content
 *     pin, so an admitted write of `module.exports={start(){process.exit(0)}}` would
 *     be every guard's off switch from the next call on. The restore commands take
 *     the content from git (the index, or HEAD), never from the call;
 *   - every other event: a loud non-JSON exit 1 (the host shows it to the user).
 * Either way stderr starts with the fixed line `[dispatch] BOOT-FAULT` (round-7 SEC
 * LOW-4), which scripts/ci/validate-hooks.js grades an error whatever the exit code
 * and whatever the error looked like (a thrown string has no stack frame).
 * RULES FOR THIS FILE: node builtins ONLY — nothing under lib/ except the body it
 * exists to load (round-7 SEC LOW-2: a broken or hostile lib module on the fault
 * path made this file fail open) — no dispatch logic, edited only to change the
 * fault reply or the hatch. Everything else belongs in lib/dispatch-main.js. Any
 * throw while answering a fault is a refusal at PreToolUse (exit 2), loud elsewhere.
 *
 * ACCEPTED RESIDUAL: this file itself deleted or unparseable still fails OPEN — the
 * host cannot run a file that is missing or does not compile, and nothing in the
 * tree runs before it. It is the one remaining single point, kept small and
 * rarely edited so the residual is as narrow as it can be (see the engine contract,
 * workspaces/hook-consolidation-2026-09-26/02-plans/01-engine-contract.md, Round-6).
 */
"use strict";

const t0 = require("perf_hooks").performance.now();
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const MAIN_REL = "hooks/lib/dispatch-main.js"; // relative to .claude/, like every hatch target
const BOOT_FAULT_MARKER = "[dispatch] BOOT-FAULT";

// The mutation tools — INLINED, not required from lib/tool-classes.js (this file loads
// node builtins only). Equal to that module's MUTATION_TOOLS set, pinned by a case in
// hook-engine.test.mjs, so the two cannot drift.
const MUTATION_TOOL_NAMES = Object.freeze(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * `p` in canonical form: every EXISTING ancestor resolved through realpath, the
 * missing tail (which holds no symlink, since it does not exist) appended as is.
 * The final component itself is NOT followed — the file may be the broken one, and
 * a symlink at the target's name is not the target (a write lands where it points).
 * Null when not even the filesystem root resolves (fail closed: matches nothing).
 */
function canonPath(p) {
  let dir = path.dirname(path.resolve(p));
  const tail = [path.basename(path.resolve(p))];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return null;
      tail.unshift(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * The repair hatch — the ONE implementation (lib/dispatch-main.js delegates here).
 * Admits: read-only lookups; an exact one-line `git checkout [HEAD] -- <file>` /
 * `git restore [--source=HEAD] [--] <file>` of one of `files`; and — ONLY when
 * `opts.edit === true` — an Edit/Write/MultiEdit/NotebookEdit whose target is one of
 * `files`. The registry faults pass `edit: true` (the loom registry is content-pinned
 * by hash, so a write of it cannot switch a pinned session's guards off; the repo's
 * own local registry only ever switches the repo's own detectors); the bootstrap's
 * own fault never does (round-7 SEC MEDIUM-1). `files` are relative to
 * .claude/. A substring match over the whole tool input would let any call that
 * merely MENTIONS the file (a comment, an argument) run with zero guards. Any throw
 * here admits nothing.
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
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return true;
  const targets = [];
  for (const f of files || []) {
    const raw = path.join(HOOKS_DIR, "..", f);
    // A target that is itself a symlink is not repaired by writing through it (the
    // write lands wherever it points) nor by a command naming it.
    try {
      if (fs.lstatSync(raw).isSymbolicLink()) continue;
    } catch {}
    const c = canonPath(raw);
    if (c !== null) targets.push(c);
  }
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
    const m = input.command.trim().match(/^git[ \t]+(?:checkout[ \t]+(?:HEAD[ \t]+)?--|restore(?:[ \t]+--source=HEAD)?(?:[ \t]+--)?)[ \t]+([^ \t]+)$/);
    // The token is what the SHELL will run, so it must be a plain path — no shell
    // syntax, no `..` segment — before its resolved form is compared at all.
    if (!m || !/^[A-Za-z0-9._\/-]+$/.test(m[1]) || m[1].split("/").includes("..")) return false;
    return matches(path.resolve(cwd, m[1]));
  }
  return false;
}
module.exports = { repairHatch, MUTATION_TOOL_NAMES, BOOT_FAULT_MARKER };

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
  const exitWith = (stdout, stderr, code) =>
    process.stderr.write(stderr, () => process.stdout.write(stdout, () => process.exit(code)));
  // The reply itself could not be built: exit 2 is a refusal at PreToolUse (and the
  // conservative answer when the event is unknown), a non-JSON exit 1 elsewhere.
  // Touches nothing of `err` — reading it may be what threw.
  const lastResort = () => {
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
    if ((event && event !== "PreToolUse") || repairHatch(payload, files)) return exitWith("", `${BOOT_FAULT_MARKER}\n[dispatch] ${msg}`, 1);
    const restore = files.map((f) => `\`git checkout -- .claude/${f}\``).join(", ");
    const reason =
      "STOP — Tool call blocked.\n\nWHAT HAPPENED: " + msg +
      "WHY: with the dispatcher unloadable no guard can run, so this call cannot be vetted. Refusing is the fail-closed disposition.\n\n" +
      "REPORT TO USER (do not skip any):\n  - The hook dispatcher is broken; quote the error above.\n" +
      `  - Repair it by restoring from git: ${restore} (or \`git restore --source=HEAD <file>\`). ` +
      "Only Read/Grep/Glob and exactly those restore commands are allowed. An Edit/Write of a hook file is NOT: with no guard " +
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
  // still answered.
  timer = setTimeout(answer, 3000);
  const s = process.stdin;
  if (!s || s.isTTY) return answer();
  s.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  s.on("end", answer);
  s.on("error", answer);
  return undefined;
}

/**
 * The COMPLETION RECORD a started body must hand back (round-8 SEC HIGH-1). "The body
 * loads and `start` is a function" describes a MODULE: `module.exports = { start(){} }`
 * is all of it, answers nothing, exits 0, and at PreToolUse the host reads empty stdout
 * at exit 0 as an ALLOWED call — every guard off with no visible signal. Fields,
 * rationale and the measured execve limit live in lib/dispatch-main.js::completion.
 * `ran` is required below, the moment start() returns; `emitted` is required HERE, at
 * exit, because a body that started and then never answered is the same defect one step
 * later. The refusal is this file's EXISTING boot-fault disposition — exit 2 with the
 * fixed BOOT-FAULT marker at PreToolUse, a loud exit 1 with the same marker elsewhere —
 * never a second deny shape. `fs.writeSync` is the one write that still lands while the
 * process is exiting, and with nothing emitted there is no reply for it to reorder. An
 * ANSWERED event returns at once and touches nothing — that is what keeps a real hook's
 * exit code unchanged — and every other step is guarded, so nothing here can throw an
 * unhandled error on the exit path.
 */
function watchEmission(rec) {
  process.on("exit", () => {
    try {
      if (rec.emitted === true) return;
      // The record's event first, then argv — the fallback bootFault starts from. An
      // unknown event takes the refusal.
      const ev = (typeof rec.event === "string" && rec.event) || process.argv[2] || null;
      try {
        fs.writeSync(2, `${BOOT_FAULT_MARKER}\n[dispatch] .claude/${MAIN_REL} answered nothing for ${ev || "this event"} — the process ended with no reply, so NO detector registered for ${ev || "this event"} ran on this call.\n`);
      } catch {}
      process.exitCode = ev && ev !== "PreToolUse" ? 1 : 2;
    } catch {}
  });
  // SIGTERM/SIGINT are CATCHABLE and do NOT emit 'exit' — node's signal default ends
  // the image outright — so exit THROUGH the listener above: one fault reply, never a
  // second copy of it. SIGKILL and an abort-driven OOM are unclosable; the limit, and
  // exactly which events it leaves silent, are named in lib/dispatch-main.js::completion.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    try {
      process.on(sig, () => { if (rec.emitted !== true) process.exit(); });
    } catch {}
  }
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
