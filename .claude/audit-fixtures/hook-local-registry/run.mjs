#!/usr/bin/env node
/**
 * Audit fixture — the REPO-LOCAL hook registry (`.claude/dispatch-registry.local.json`,
 * the consumer-owned surface a repo registers its own detectors in; sync-manifest
 * `target_owned:`), as the dispatcher consumes it (lib/dispatch-registry.js +
 * lib/dispatch-main.js + lib/local-supervisor.js).
 *
 * WHAT IS PINNED. Four trust constraints the local surface owes beside the template
 * registry, each with a CONTROL on the same tree (the defect this family keeps
 * finding is a green whose instrument never discriminated):
 *
 *   A  a valid local row RUNS beside loom's rows, with the host's exact stdin/env
 *      contract, and its deny refuses the call (control: the same row on a
 *      non-matching call is silent; no local file at all is silent).
 *   B  ADD-ONLY — a local row naming a hook the TEMPLATE registry dispatches for
 *      the same event is a TYPED refusal of the whole file, at LOAD, case-folded
 *      (control: the same file with the row renamed runs both rows). Two boundaries
 *      are pinned with it, because both are places the check could over-reach: a
 *      template hook registered only for ANOTHER event, and a template row THIS
 *      TREE does not run (`loom_only` outside loom) — an ineligible loom row has
 *      never been allowed to block the repo's own row of that name.
 *   C  a local row declaring `on_incomplete:"deny"` — and, fail-closed, a row that
 *      declares NOTHING — REFUSES at PreToolUse when it crashes, overruns its own
 *      budget, or exits non-zero without a JSON reply (control: `on_incomplete:
 *      "continue"` on the SAME row does not refuse), and a DENY-class row the event
 *      deadline starves is refused WITHOUT the repair hatch (control: a `continue`
 *      one keeps it).
 *   D  the local file is PINNED to the session's first read and the pin is an
 *      ACCEPTANCE RECORD, not a cache: the pinned text and the anchor recording
 *      which sha the session accepted are BOTH required, so a row removed, a file
 *      deleted, or the pin itself DELETED or REPLACED mid-session cannot switch a
 *      repo guard off (a row removed or the file deleted ⇒ the accepted text runs and
 *      a NOTICE says so; the pin deleted or replaced ⇒ REFUSAL with its own name).
 *      Control: a NEW session reads the edited file (cases 26, 30, 31).
 *   E  a local row for an event this tree's registry does not dispatch is NAMED, with
 *      its event, instead of being dropped in withLocal's silence (case 33).
 *   F  DIVERGENT duplicate declarations on one hook are refused at load, in either
 *      order: the two lookups that consume `on_incomplete` would otherwise disagree,
 *      which is fail-OPEN in one order and over-refusing in the other (case 32;
 *      identical duplicates load and collapse to one run — 32b).
 *
 * WHY THIS RUNNER DRIVES THE REAL DISPATCHER. The claims above are about the
 * DISPOSITIONS the host sees — exit codes, merged context, the refusal text — not
 * about predicates. Every case copies `dispatch.js` + the seven libs into a
 * throwaway tree, writes toy loom/repo hooks and both registries there, and runs
 * `node <tree>/.claude/hooks/dispatch.js PreToolUse` exactly as settings.json would.
 * The dispatcher resolves hooks/registries from its OWN directory, so the sandbox
 * is the only PROJECT tree any case touches — the checkout's `.claude/` is read,
 * never written, by this runner. The session pins the suite provokes are written
 * under a RUNNER-OWNED `XDG_RUNTIME_DIR` (PIN_ROOT, one mkdtemp per run, removed on
 * exit): the first revision pointed them at the operator-shared
 * `$TMPDIR/coc-dispatch-registry-<uid>` and removed nothing (measured by the
 * correctness round: ~6-9 leaked pin files per run, nothing cleaned).
 * ONE case (10, case-folding) is a predicate call instead, and for a measured
 * reason: through a tree it is HOST-DEPENDENT — it passed on macOS and failed on the
 * Linux gate host, where `LOOM-GUARD.js` is a different path, `eligible()` says the
 * template row is not live, and the collision legitimately does not fire. The
 * runner must give the same verdict on both hosts; the portable claim is the
 * compare, so that is what case 10 pins.
 *
 * BIPOLAR BY CONSTRUCTION. Every refusal above is paired with the same input on a
 * tree where the declaration differs, so a detector that refuses everything and one
 * that refuses nothing both red. `reds_under` names the mutation each case is
 * established against.
 *
 * ESTABLISHED RED (instrument-discipline.md MUST-2), MEASURED BEFORE THIS FILE WAS
 * REGISTERED. The battery runs against a SCRATCH copy of `.claude/hooks/` (the lane
 * tree is never mutated); per mutation it asserts the anchor occurs exactly once,
 * that the bytes actually changed, `node --check`s the mutant, runs THIS runner
 * against it, records the failing case ids, restores from the pre-run text, and
 * verifies the restore by sha256 — plus one unmutated scratch control. Every
 * mutation reds at least one case; none is inert. Observed, against the THIRTY-ONE
 * cases this matrix was measured on (cases 30-33 arrived with the security round,
 * after it; the per-fix reverts below are the ones measured against all thirty-six,
 * and the matrix is re-measured in full at the next greenlit heavy run):
 *   M-1  dispatch-main.js: drop the assertAddOnly call                  → 06 07 08
 *   M-2  dispatch-registry.js: the collision compare is case-SENSITIVE  → 10
 *   M-3  dispatch-main.js: no local row is marked deny-class            → 15 17 20
 *   M-4  dispatch-main.js: drop the SECOND applyIncompleteDenyRefusals  → 15 17
 *   M-5  dispatch-main.js: drop `budgetFault.noHatch`                   → 20
 *   M-6  dispatch-registry.js: serve the LIVE text over the pin         → 23 25
 *   M-7  dispatch-registry.js: key the pin by session id alone          → 22 27
 *   M-8  dispatch-registry.js: pin an ABSENT registry too               → 28 29
 *   M-9  dispatch-registry.js: refuse EVERY local row (the over-refusal
 *        pole of every control)     → 02a 02b 03 05 07 10 11 12 15 16 17 18 19 20
 *                                      22 23 24 25 27 29
 *   M-10 dispatch-registry.js: scope the collision check to ALL events  → 12
 *   M-11 dispatch-registry.js: a malformed file reads as empty          → 13
 *   M-12 dispatch-registry.js: pin the text before it is ACCEPTED       → 14
 *   M-13 dispatch-registry.js: the collision check ignores ELIGIBILITY  → 12b
 * M-12 IS case 14's reason to exist: before the pin moved behind acceptance, a
 * malformed registry was pinned and the repaired file kept being refused until the
 * session restarted (measured while building this). M-13 IS case 12b's, and it was
 * found the hard way — the first cut of the add-only check ignored eligibility and
 * refused a file the runtime would have run, an ineligible `loom_only` row blocking
 * the repo's own row of that name, the very shadowing the invariant exists to
 * prevent; a suite case that pinned the opposite went green for the wrong reason
 * (the refusal is also an exit 2) and was sharpened to assert the repo row RAN.
 * Two cases were REWRITTEN because the battery, not the prose, said they measured
 * nothing: case 12's local row named a repo file, so widening the collision check to
 * every event changed nothing (it now names the other event's hook); and case 27's
 * second tree reused the first's registry CONTENT, so an inherited pin was invisible
 * (it now carries a different registry and probes with the first tree's needle). And
 * case 10 moved from a tree to a PREDICATE call for a measured reason: through a
 * tree it passed on macOS and failed on the Linux gate host, where a differently
 * cased name is a different path and the collision legitimately does not fire — the
 * runner must give one verdict on both hosts. That is the difference between running
 * a mutation and predicting it.
 * PER-FIX REVERTS (the security round's ruling: each fix's NAMED regression case must
 * red when THAT fix alone is reverted). Measured the same way — scratch copy, anchor
 * count asserted, `node --check`, run, restore, restore verified byte-equal, control
 * 36/36 — one fix at a time:
 *   REV-1  the pin's pre-fix semantics restored (the pin FILE alone decides; the
 *          anchor is not consulted)                          → 30 31 (ONLY these)
 *   REV-2  the divergent-duplicate check removed             → 32 (ONLY)
 *   REV-3  the undispatchable-event notice removed           → 33 (ONLY)
 * Each reds exactly its own case and nothing else, which is what makes the three
 * named cases load-bearing for the three fixes rather than for the batch.
 * THE COUNTS ABOVE ARE HISTORICAL AND STAY TRUE OF THE RUNS THEY DESCRIBE: the
 * revert battery was measured against the thirty-six-case revision, where the
 * control read 36/36. The suite has since grown group G (cases 34-35, the legacy
 * row's incomplete-execution pair) and group H (cases 36-37, the supervisor-path
 * pair), so a control on a FULLY composed tree reads 40/40 — while the H8
 * fold-in's seven-path stage MEASURED 26/40, because that stage deliberately
 * excludes `dispatch-main.js` (agent A's file), whose local-branch wiring is what
 * cases 06-08, 15, 17, 20, 22-25, 30-31, 33 and 36 exercise. The floor in
 * ci-audit-fixtures.json is the CASE count and is raised with every addition; it
 * is never the pass count, which is a function of how much of the composition has
 * landed. (26/40 is a MEASUREMENT from that run's own summary, not an estimate —
 * the first draft of this paragraph predicted 27 and the run corrected it.)
 * Cases 04, 09, 21 and 26 carry no battery mutation: each guards a specific
 * non-refusal disposition (the OPTIONAL default, loom's context beside a refusal, a
 * `continue` row, a new session) that no single-line mutant in this set moves.
 * The tree builder REFUSES two sources for one file name (it throws). During the
 * probe phase, before this runner existed, an ad-hoc probe tree silently let a local
 * row's file overwrite the loom one, and the add-only mutation reddened nothing —
 * the guard exists so that shape cannot recur silently.
 *
 * Cases 04, 09, 21 and 26 carry no battery mutation: each guards a specific
 * non-refusal disposition (the OPTIONAL default, loom's context beside a refusal, a
 * `continue` row, a new session) that no single-line mutant in this set moves.
 * The tree builder REFUSES two sources for one file name (it throws). During the
 * probe phase, before this runner existed, an ad-hoc probe tree silently let a local
 * row's file overwrite the loom one, and the add-only mutation reddened nothing —
 * the guard exists so that shape cannot recur silently.
 *
 * OWNER/CONSUMER: on a tree whose `.claude/dispatch-registry.local.json` is absent
 * (loom itself, and every consumer that registers nothing) the runner's subject is
 * never reached — that is the OPTIONAL contract, pinned at case 05, and it is why
 * case 01 hashes the copied dispatcher rather than assuming the tree it drives.
 *
 * No network, no ambient git (scrubbed), no writes outside runner-created
 * sandboxes; every sandbox is removed on exit.
 */

import "../_lib/no-ambient-git.cjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO, ".claude", "hooks");
const WIN = process.platform === "win32";
const LIBS = ["dispatch-main.js", "dispatch-registry.js", "hook-engine.js", "hook-engine-worker.js", "event-git.js", "tool-classes.js", "local-supervisor.js"];

const cases = [];
function check(name, cond, detail, reds_under) {
  cases.push({ name, pass: !!cond, detail: String(detail || ""), reds_under: reds_under || "" });
}

// ---------------------------------------------------------------------------
// the sandbox tree — the real dispatcher, toy hooks, both registries
// ---------------------------------------------------------------------------
const sandboxes = [];
// Runner-owned snapshot dir (see the dispatch env below): one per run, removed on
// exit with the sandboxes.
const PIN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hlr-pinroot-"));
const cmd = (h) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${h}"`;
const row = (h, extra) => ({ type: "command", command: cmd(h), timeout: 5, ...extra });
const grp = (matcher, ...hooks) => ({ matcher, hooks: hooks.map((h) => (typeof h === "string" ? row(h) : h)) });

/**
 * A throwaway project tree. `loomFiles`/`localFiles` are SOURCE, not categories —
 * they share one directory (that is the point of the local registry: both live in
 * .claude/hooks/). Two sources for ONE name is a fixture bug, not an overwrite, and
 * throws (it produced an inert mutation once; see the header).
 */
function mkTree({ loomFiles = {}, localFiles = {}, loomGroups = [], localGroups = [], localRaw = null, localAbsent = false, events = null, loomOnly = null, version = null } = {}) {
  const overlap = Object.keys(loomFiles).filter((k) => k in localFiles);
  if (overlap.length) throw new Error(`fixture bug: two sources for ${overlap.join(", ")}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hlr-"));
  sandboxes.push(root);
  const dir = path.join(root, ".claude", "hooks");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(HOOKS, "dispatch.js"), path.join(dir, "dispatch.js"));
  for (const f of LIBS) fs.copyFileSync(path.join(HOOKS, "lib", f), path.join(dir, "lib", f));
  fs.writeFileSync(path.join(dir, "loom-noop.js"), `"use strict";
function hookMain() { process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "LOOM-NOOP" } }) + "\\n"); process.exit(0); }
module.exports = { hookMain };
if (require.main === module) hookMain();
`);
  for (const [n, s] of Object.entries({ ...loomFiles, ...localFiles })) fs.writeFileSync(path.join(dir, n), s);
  const spec = events || { PreToolUse: { dispatcher: { matcher: "*", timeout: 60 }, groups: loomGroups.length ? loomGroups : [grp("*", "loom-noop.js")] } };
  fs.writeFileSync(path.join(dir, "dispatch-registry.json"), JSON.stringify({ schema: 1, events: spec, ...(loomOnly ? { loom_only: loomOnly } : {}) }));
  // A tree's CLASS is read from `.claude/VERSION` (repoClass): without one the tree
  // is "unreadable" and loom_only rows are RUN (the enforcement side), which is a
  // different case from the consumer this fixture's eligibility case needs.
  if (version) fs.writeFileSync(path.join(root, ".claude", "VERSION"), JSON.stringify(version));
  const lp = path.join(root, ".claude", "dispatch-registry.local.json");
  if (localRaw !== null) fs.writeFileSync(lp, localRaw);
  else if (localGroups.length) fs.writeFileSync(lp, JSON.stringify({ schema: 1, events: { PreToolUse: { groups: localGroups } } }));
  else if (!localAbsent) fs.writeFileSync(lp, JSON.stringify({ schema: 1, events: {} }));
  return { root, dir, lp, sid: `sess-${crypto.randomBytes(8).toString("hex")}` };
}

/** Run the real dispatcher in its own process group; one JSON reply per call. */
function dispatch(t, payload, { timeoutMs = 30000, env = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(t.dir, "dispatch.js"), "PreToolUse"], {
      detached: !WIN,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: t.root,
      // XDG_RUNTIME_DIR points at a RUNNER-OWNED directory (PIN_ROOT): the
      // snapshot-dir choice, and so every pin this suite writes, lands in a tree the
      // runner created and removes — never the operator-shared
      // `$TMPDIR/coc-dispatch-registry-<uid>`, which the first revision of this
      // runner leaked into (measured: ~6-9 pins per run, nothing removed; the
      // correctness round counted them). A host that exports its own
      // XDG_RUNTIME_DIR cannot move the pins out of the directory the cases check.
      env: { ...process.env, CLAUDE_PROJECT_DIR: t.root, COC_DISPATCH_TRACE: "", XDG_RUNTIME_DIR: PIN_ROOT, ...env },
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const k = setTimeout(() => {
      try {
        if (!WIN) process.kill(-c.pid, "SIGKILL");
        else c.kill();
      } catch {}
    }, timeoutMs);
    c.on("close", (code) => {
      clearTimeout(k);
      resolve({ code, stdout, stderr });
    });
    c.stdin.end(JSON.stringify(payload));
  });
}

const call = (t, command, { tool = "Bash", event = "PreToolUse" } = {}) => ({
  hook_event_name: event,
  tool_name: tool,
  tool_input: tool === "Bash" ? { command } : { file_path: "/tmp/x" },
  cwd: "/tmp",
  session_id: t.sid,
});
const ctxOf = (r) => {
  try {
    const j = JSON.parse(r.stdout);
    const h = j.hookSpecificOutput || {};
    return h.additionalContext || h.permissionDecisionReason || "";
  } catch {
    return "";
  }
};
const has = (r, re) => re.test(ctxOf(r)) || re.test(r.stderr || "");
// Some reports ride the reply's OWN fields (`systemMessage` — how the dispatcher
// delivers a failed non-blocking detector), which ctxOf does not read.
const raw = (r, re) => re.test(r.stdout || "") || re.test(r.stderr || "");

// ---------------------------------------------------------------------------
// toy repo-owned detectors (plain scripts: read stdin, speak on stdout)
// ---------------------------------------------------------------------------
const repoDenyOn = (needle) => `let i = ""; process.stdin.on("data", (c) => (i += c)); process.stdin.on("end", () => {
  if (JSON.parse(i).tool_input.command.includes(${JSON.stringify(needle)})) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "DENIED-BY-REPO" } }) + "\\n");
    process.exit(2);
  }
  process.stdout.write('{"continue":true}\\n'); process.exit(0);
});`;
const repoCrash = `process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("repo detector boom\\n"); process.exit(3); });`;
const repoHang = `process.stdin.resume(); process.stdin.on("end", () => { setInterval(() => {}, 1000); });`;

// ---------------------------------------------------------------------------
// 01 — provenance: the tree this runner drives is the checkout's dispatcher
// ---------------------------------------------------------------------------
{
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const t = mkTree({});
  const same = ["dispatch.js", ...LIBS.map((f) => path.join("lib", f))].every((rel) => sha(path.join(t.dir, rel)) === sha(path.join(HOOKS, rel)));
  const inside = sandboxes.every((s) => path.resolve(s).startsWith(path.resolve(os.tmpdir())) && !path.resolve(s).startsWith(path.resolve(REPO)));
  check("01 provenance/isolation: the copied dispatcher is byte-equal to the checkout's, and every sandbox is outside the checkout", same && inside, `equal=${same} outside=${inside}`, "(no battery mutation: a provenance case, not a behaviour case)");
}

// ---------------------------------------------------------------------------
// A — a valid local row runs beside loom's rows
// ---------------------------------------------------------------------------
{
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  const hit = await dispatch(t, call(t, "rm -rf /x"));
  check("02a A: a valid local deny row DENIES the matching call (exit 2, its reason delivered)", hit.code === 2 && has(hit, /DENIED-BY-REPO/), `exit=${hit.code}`, "M-9: a check that refuses every local row");
  const miss = await dispatch(t, call(t, "ls"));
  check("02b A control: the SAME row on a non-matching call is silent (exit 0, no reason)", miss.code === 0 && !has(miss, /DENIED-BY-REPO/), `exit=${miss.code}`, "M-9 (the whole file is refused, so the row never runs)");
}
{
  const t = mkTree({ localFiles: { "rep-ctx.js": `let i="";process.stdin.on("data",(c)=>i+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({continue:true,hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"REPO-SPOKE"}})+"\\n");process.exit(0);});` }, localGroups: [grp("Bash", "rep-ctx.js")] });
  const r = await dispatch(t, call(t, "ls"));
  check("03 A: a local advisory row's context is merged BESIDE loom's (both delivered)", r.code === 0 && has(r, /REPO-SPOKE/) && has(r, /LOOM-NOOP/), `exit=${r.code}`, "M-9");
}
{
  const t = mkTree({ localAbsent: true });
  const r = await dispatch(t, call(t, "ls"));
  check("04 A: no local registry file at all ⇒ loom's rows run, exit 0, no notes", r.code === 0 && has(r, /LOOM-NOOP/) && !/HOOK DISPATCHER (NOTES|NOTICE)/.test(ctxOf(r)), `exit=${r.code}`, "(no battery mutation: the OPTIONAL contract — a missing file is not a fault)");
}
{
  // A payload with no session_id: the pin cannot be anchored and the file is read
  // fresh, exactly as before the pin existed — pinned so the fallback is deliberate.
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  const noSid = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /x" }, cwd: "/tmp" };
  const r = await dispatch(t, noSid);
  check("05 A: a payload with NO session_id still runs the local row (unpinned fallback, no notice)", r.code === 2 && has(r, /DENIED-BY-REPO/) && !/pin/i.test(ctxOf(r)), `exit=${r.code}`, "M-9");
}

// ---------------------------------------------------------------------------
// B — ADD-ONLY: naming a template hook registered for the same event
// ---------------------------------------------------------------------------
const LOOMGUARD = `"use strict";
function hookMain() { process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "LOOM-GUARD-RAN" } }) + "\\n"); process.exit(0); }
module.exports = { hookMain };
if (require.main === module) hookMain();
`;
const REPOOK = `let i="";process.stdin.on("data",(c)=>i+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({continue:true,hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"REPO-SPOKE"}})+"\\n");process.exit(0);});`;
{
  const t = mkTree({ loomFiles: { "loom-guard.js": LOOMGUARD }, loomGroups: [grp("*", "loom-guard.js")], localFiles: { "rep.js": REPOOK }, localGroups: [grp("Bash", "rep.js"), grp("Bash", "loom-guard.js")] });
  const r = await dispatch(t, call(t, "ls"));
  check("06 B: a local row naming a template hook registered for the SAME event is REFUSED at PreToolUse (exit 2)", r.code === 2, `exit=${r.code}`, "M-1: the add-only check is not wired");
  check("07 B: ...the refusal is TYPED and names the row, the file and the add-only rule", has(r, /COLLIDES with a detector/) && has(r, /ADD-ONLY/) && has(r, /row for loom-guard\.js COLLIDES/), "refusal without the collision named", "M-1, M-9");
  check("08 B: ONE colliding row refuses the WHOLE file — the tree's legitimate row does NOT run", r.code === 2 && !has(r, /REPO-SPOKE/), "a colliding row dropped while the rest run", "M-1");
  check("09 B: loom's OWN detectors still ran (their context rides the refusal)", has(r, /LOOM-GUARD-RAN/), "loom context lost beside the refusal", "(no battery mutation: guards a fix that drops loom's context beside the refusal)");
}
{
  // Case-folded, pinned AT THE PREDICATE — deliberately not through a tree. On a
  // case-insensitive filesystem (macOS) a local row naming `LOOM-GUARD.js` is a row
  // naming the same FILE as the template's `loom-guard.js`, so the dispatcher-level
  // case is real there; on Linux it is a different path, `eligible()` says the
  // template row is not live here, and the collision legitimately does not fire.
  // A tree-level case would therefore be HOST-DEPENDENT — it passed on macOS and
  // failed on the Linux gate host (measured), which is the class this rewrite
  // closes. What is portably true is the compare itself.
  const reg = require(path.join(HOOKS, "lib", "dispatch-registry.js"));
  const hookRow = (name) => ({ matcher: "Bash", hooks: [{ type: "command", command: cmd(name), timeout: 5 }] });
  const template = { schema: 1, events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 60 }, groups: [hookRow("loom-guard.js")] } } };
  const probe = (name) => {
    try {
      reg.assertAddOnly({ schema: 1, events: { PreToolUse: { groups: [hookRow(name)] } } }, template);
      return null;
    } catch (e) {
      return e.code || e.message;
    }
  };
  check("10 B: the collision compare is CASE-FOLDED (LOOM-GUARD.js collides; control: a distinct name does not)", probe("LOOM-GUARD.js") === "ADD_ONLY_VIOLATION" && probe("rep.js") === null, `cased=${probe("LOOM-GUARD.js")} distinct=${probe("rep.js")}`, "M-2: a case-sensitive compare");
}
{
  const t = mkTree({ loomFiles: { "loom-guard.js": LOOMGUARD }, loomGroups: [grp("*", "loom-guard.js")], localFiles: { "rep.js": REPOOK }, localGroups: [grp("Bash", "rep.js")] });
  const r = await dispatch(t, call(t, "ls"));
  check("11 B control: the same file with the colliding row RENAMED runs both rows (exit 0, both contexts)", r.code === 0 && has(r, /REPO-SPOKE/) && has(r, /LOOM-GUARD-RAN/), `exit=${r.code}`, "M-9: a check that refuses any local row");
}
{
  // Boundary: a template hook registered for a DIFFERENT event is NOT a collision —
  // the local row ADDS a run of that file here, it cannot shadow one that is not
  // dispatched on this event. The row NAMES loom-guard.js (a template hook for
  // PostToolUse and for no other event), which is what makes the case discriminating:
  // a check scoped to every event would refuse this file.
  const t = mkTree({
    loomFiles: { "loom-guard.js": LOOMGUARD },
    loomGroups: [grp("*", "loom-guard.js")],
    localFiles: { "rep.js": REPOOK },
    localGroups: [grp("Bash", "loom-guard.js"), grp("Bash", "rep.js")],
    events: {
      PreToolUse: { dispatcher: { matcher: "*", timeout: 60 }, groups: [grp("*", "loom-noop.js")] },
      PostToolUse: { dispatcher: { matcher: "*", timeout: 60 }, groups: [grp("*", "loom-guard.js")] },
    },
  });
  const r = await dispatch(t, call(t, "ls"));
  check("12 B boundary: a template hook registered only for ANOTHER event is not a collision (the local file loads and runs it here)", r.code === 0 && has(r, /LOOM-GUARD-RAN/) && has(r, /REPO-SPOKE/), `exit=${r.code}`, "M-9, M-10: a collision check scoped to all events");
}
{
  // Boundary: a template row THIS TREE does not run (here `loom_only`, and the tree
  // is a consumer) shadows nothing. The dispatcher's rule has always been that an
  // INELIGIBLE loom row must not block the repo's own row of that name, so the load
  // check consults the same eligibility predicate — and the local row is the only
  // thing that can run g1.js here (the loom row is ineligible), which is why its
  // context is the assertion.
  const t = mkTree({
    loomFiles: { "g1.js": REPOOK },
    loomGroups: [grp("*", "g1.js")],
    localGroups: [grp("Bash", "g1.js")],
    loomOnly: ["g1.js"],
    version: { type: "coc-project" },
  });
  const r = await dispatch(t, call(t, "ls"));
  check("12b B boundary: a template row that is NOT ELIGIBLE here (loom_only outside loom) is no collision — the repo's row of that name runs", r.code === 0 && has(r, /REPO-SPOKE/) && !has(r, /COLLIDES/), `exit=${r.code}`, "M-13: the collision check ignores eligibility");
}
{
  const t = mkTree({ localRaw: "{ this is not json" });
  const r = await dispatch(t, call(t, "ls"));
  check("13 B: a MALFORMED local file is refused loudly at PreToolUse, naming the file (never silence, never fail-open)", r.code === 2 && has(r, /dispatch-registry\.local\.json/) && has(r, /unparseable JSON/), `exit=${r.code}`, "M-11: a malformed file read as an empty one");
  fs.writeFileSync(t.lp, JSON.stringify({ schema: 1, events: {} }));
  const fixed = await dispatch(t, call(t, "ls"));
  check("14 B control: the SAME call after the file is repaired passes (exit 0)", fixed.code === 0 && has(fixed, /LOOM-NOOP/), `exit=${fixed.code}`, "M-12: pinned before acceptance — the trap this two-step closes");
}

// ---------------------------------------------------------------------------
// C — on_incomplete, the same contract template rows carry
// ---------------------------------------------------------------------------
const rowD = (h, onIncomplete) => grp("Bash", row(h, onIncomplete ? { on_incomplete: onIncomplete } : {}));
{
  const t = mkTree({ localFiles: { "rep-crash.js": repoCrash }, localGroups: [grp("Bash", row("rep-crash.js", {}))] });
  const r = await dispatch(t, call(t, "ls"));
  check("15 C: a local row declaring NOTHING (default = deny) that exits non-zero without a reply REFUSES at PreToolUse", r.code === 2 && has(r, /declares on_incomplete:"deny" and did NOT complete/) && has(r, /exited 3 without a JSON reply/), `exit=${r.code}`, "M-3, M-4, M-9");
}
{
  const t = mkTree({ localFiles: { "rep-crash.js": repoCrash }, localGroups: [rowD("rep-crash.js", "continue")] });
  const r = await dispatch(t, call(t, "ls"));
  check("16 C control: the SAME crash with on_incomplete:\"continue\" does NOT refuse (host-kill disposition, reported loudly)", r.code !== 2 && raw(r, /rep-crash\.js failed \(exit 3\)/), `exit=${r.code}`, "M-9 (only the over-refusal pole moves it)");
}
{
  const t = mkTree({ localFiles: { "rep-hang.js": repoHang }, localGroups: [rowD("rep-hang.js", "deny")] });
  const r = await dispatch(t, call(t, "ls"));
  check("17 C: a local DENY row that overruns its OWN budget REFUSES (exit 2, \"overran its own budget\")", r.code === 2 && has(r, /overran its own budget/), `exit=${r.code}`, "M-3, M-4, M-9");
}
{
  const t = mkTree({ localFiles: { "rep-hang.js": repoHang }, localGroups: [rowD("rep-hang.js", "continue")] });
  const r = await dispatch(t, call(t, "ls"));
  check("18 C control: the same overrun with \"continue\" is not refused, and IS named in the notes", r.code !== 2 && has(r, /exceeded its own timeout/), `exit=${r.code}`, "M-9");
}
{
  // A row that COMPLETES - exit 0 with a JSON reply - is not incomplete at all.
  const t = mkTree({ localFiles: { "rep-ok.js": REPOOK }, localGroups: [rowD("rep-ok.js", "deny")] });
  const r = await dispatch(t, call(t, "ls"));
  check("19 C: a deny-class row that COMPLETES (exit 0 + JSON) is not refused — the contract is incompleteness, not deny-capability", r.code === 0 && has(r, /REPO-SPOKE/), `exit=${r.code}`, "M-9");
}
{
  // STARVED by the EVENT deadline (the dispatcher's own timeout, minus its 2 s
  // reserve): a deny-class row loses the repair hatch a `continue` one keeps.
  // matcher `*`: the call below is a READ, and a row registered for `Bash` would not
  // be selected at all — the fault must come from the row being starved, not skipped.
  const mk = (onIncomplete) =>
    mkTree({
      localFiles: { "rep-hang.js": repoHang },
      localGroups: [grp("*", row("rep-hang.js", { timeout: 60, ...(onIncomplete ? { on_incomplete: onIncomplete } : {}) }))],
      events: { PreToolUse: { dispatcher: { matcher: "*", timeout: 5 }, groups: [grp("*", "loom-noop.js")] } },
    });
  const readCall = (t) => ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: "/tmp", session_id: t.sid });
  const denyT = mk("deny");
  const denied = await dispatch(denyT, readCall(denyT));
  check("20 C: a DENY-class row the EVENT deadline starves refuses a Read too — no repair hatch", denied.code === 2 && has(denied, /time budget ran out|was killed at the event deadline|was not started/), `exit=${denied.code}`, "M-3, M-5, M-9");
  const contT = mk("continue");
  const admitted = await dispatch(contT, readCall(contT));
  check("21 C control: the SAME starvation on a `continue` row still admits a Read (the hatch exists, and is the thing 20 withholds)", admitted.code === 0, `exit=${admitted.code}`, "(no battery mutation: the starved-row hatch, in the admitting direction)");
}

// ---------------------------------------------------------------------------
// D — the session pin
// ---------------------------------------------------------------------------
const pinDir = () => {
  // The dir the dispatcher resolves for PIN_ROOT (snapshotDirChoice appends this
  // name under XDG_RUNTIME_DIR when that is an absolute, private directory).
  return path.join(PIN_ROOT, "coc-dispatch-registry");
};
const anchorFileFor = (t) => pinFileFor(t).replace(/\.pin$/, ".anchor");
const pinFileFor = (t) => {
  const reg = require(path.join(HOOKS, "lib", "dispatch-registry.js"));
  // The dispatcher keys the pin on the registry path as IT sees it — `__dirname` is
  // realpath'd by node, so on macOS a /var/folders sandbox reads back as
  // /private/var/folders and a path built from the spawn-time string would look for
  // the pin in the wrong place (measured: the pin WAS written, the check said false).
  return reg.localRegistryPinPath(pinDir(), t.sid, path.join(fs.realpathSync(t.root), ".claude", "dispatch-registry.local.json"));
};
{
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  const first = await dispatch(t, call(t, "rm -rf /x"));
  const pin = pinFileFor(t);
  const anchor = anchorFileFor(t);
  check(
    "22 D: the session's first read WRITES the pin AND its acceptance anchor (private dir, mode 0600)",
    first.code === 2 && fs.existsSync(pin) && fs.existsSync(anchor) && (WIN || ((fs.statSync(pin).mode & 0o777) === 0o600 && (fs.statSync(anchor).mode & 0o777) === 0o600)),
    `exit=${first.code} pin=${fs.existsSync(pin)} anchor=${fs.existsSync(anchor)}`,
    "M-6, M-7: no pin (or no anchor) is ever written",
  );
  fs.writeFileSync(t.lp, JSON.stringify({ schema: 1, events: {} })); // the row is REMOVED mid-session
  const second = await dispatch(t, call(t, "rm -rf /x"));
  check("23 D: the row REMOVED on disk mid-session still refuses — the pinned text runs", second.code === 2 && has(second, /DENIED-BY-REPO/), `exit=${second.code}`, "M-6, M-9");
  check("24 D: ...and a NOTICE says the file on disk is not what ran", has(second, /changed on disk since this session first read it/) && has(second, /registry this session ACCEPTED/), "a silent stale read", "M-6, M-9");
}
{
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  await dispatch(t, call(t, "ls"));
  fs.unlinkSync(t.lp); // DELETED mid-session
  const r = await dispatch(t, call(t, "rm -rf /x"));
  check("25 D: the file DELETED mid-session is served from the pin (the deny still fires) and said out loud", r.code === 2 && has(r, /DENIED-BY-REPO/) && has(r, /cannot be read \(it does not exist\)/), `exit=${r.code}`, "M-6, M-9");
}
{
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  await dispatch(t, call(t, "ls"));
  fs.writeFileSync(t.lp, JSON.stringify({ schema: 1, events: {} }));
  t.sid = `sess-${crypto.randomBytes(8).toString("hex")}`; // a NEW session
  const r = await dispatch(t, call(t, "rm -rf /x"));
  check("26 D control: a NEW session reads the EDITED file (the pin is per session, not a freeze)", r.code === 0 && !has(r, /DENIED-BY-REPO/), `exit=${r.code}`, "(no battery mutation: the pin is per session, not a freeze)");
}
{
  // Two trees, one session id, DIFFERENT registries: the pin is keyed by the
  // registry's PATH too. B's file carries no rows, so a pin inherited from A (whose
  // text carries the deny row) would refuse B's call — the direction this case reads.
  const a = mkTree({ localFiles: { "rep-a.js": repoDenyOn("alpha") }, localGroups: [grp("Bash", "rep-a.js")] });
  await dispatch(a, call(a, "ls"));
  const b = mkTree({ localFiles: { "rep-b.js": repoDenyOn("beta") }, localGroups: [grp("Bash", "rep-b.js")] });
  b.sid = a.sid;
  // The probe carries A's needle and not B's: a pin inherited from A would refuse it.
  const r = await dispatch(b, call(b, "alpha"));
  check("27 D: a SECOND tree reusing the same session id is not served the first tree's pin (keyed by registry path)", r.code === 0 && !has(r, /changed on disk|STARTED with|ACCEPTED/), `exit=${r.code}`, "M-7: the pin keyed by session id alone, M-9");
}
{
  // OPTIONAL contract: a tree with NO local registry writes no pin, ever.
  const t = mkTree({ localAbsent: true });
  await dispatch(t, call(t, "ls"));
  check(
    "28 D: no local registry ⇒ NO pin and NO anchor are written (the OPTIONAL contract is not bookkept)",
    !fs.existsSync(pinFileFor(t)) && !fs.existsSync(anchorFileFor(t)),
    "a pin written for an absent registry",
    "M-8: absence pinned",
  );
}
{
  // A registry APPEARING mid-session is an addition (rows can only add), so it runs —
  // pinned here so the disposition is a decision, not an accident.
  const t = mkTree({ localAbsent: true });
  await dispatch(t, call(t, "ls"));
  fs.writeFileSync(t.dir + "/rep.js", repoDenyOn("rm -rf"));
  fs.writeFileSync(t.lp, JSON.stringify({ schema: 1, events: { PreToolUse: { groups: [grp("Bash", "rep.js")] } } }));
  const r = await dispatch(t, call(t, "rm -rf /x"));
  check("29 D boundary: a registry APPEARING mid-session runs (additions are not pinned; only removals are denied)", r.code === 2 && has(r, /DENIED-BY-REPO/), `exit=${r.code}`, "M-8, M-9");
}

// ---------------------------------------------------------------------------
// E — the pin is an ACCEPTANCE RECORD (security round: p1 / p2b)
// ---------------------------------------------------------------------------
{
  // p1: the pin is DELETED mid-session and the registry is edited. Before the
  // anchor this re-pinned the EDITED text silently (exit 0, no notice, pin
  // rewritten); now the session's acceptance record outlives the pin file and the
  // divergence is a refusal that stays refused until the session is restarted.
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  await dispatch(t, call(t, "ls"));
  const pin = pinFileFor(t);
  // Guarded: under a mutation that stops the pin being written at all, an unguarded
  // unlink CRASHES the runner and masks which other cases the mutant reds (measured
  // with the M-9 mutant). A missing pin here is the case's FAIL, not the run's end.
  if (fs.existsSync(pin)) fs.unlinkSync(pin);
  fs.writeFileSync(t.lp, JSON.stringify({ schema: 1, events: {} }));
  const r = await dispatch(t, call(t, "rm -rf /x"));
  const r3 = await dispatch(t, call(t, "rm -rf /x"));
  check(
    "30 E: the pin DELETED mid-session + an edited registry ⇒ REFUSE — never a silent re-pin of the edited text",
    r.code === 2 && !has(r, /DENIED-BY-REPO/) && has(r, /pin .* is GONE/) && !fs.existsSync(pin) && r3.code === 2,
    `exit=${r.code} re-pinned=${fs.existsSync(pin)} next=${r3.code}`,
    "the security round's p1 probe (before the fix: exit 0, no notice, pin silently rewritten over the edited text)",
  );
}
{
  // p2b: a self-consistent pin (sha256(text)\ntext) planted over the session's own.
  // Before the anchor it was SERVED, and the note blamed the live file for a change
  // the live file never made.
  const t = mkTree({ localFiles: { "rep.js": repoDenyOn("rm -rf") }, localGroups: [grp("Bash", "rep.js")] });
  await dispatch(t, call(t, "ls"));
  const forged = JSON.stringify({ schema: 1, events: {} });
  fs.writeFileSync(pinFileFor(t), `${crypto.createHash("sha256").update(forged).digest("hex")}\n${forged}`);
  const r = await dispatch(t, call(t, "rm -rf /x"));
  check(
    "31 E: a REPLACED (self-consistent but not this session's) pin ⇒ REFUSE, and no notice blaming the live file",
    r.code === 2 && !has(r, /DENIED-BY-REPO/) && has(r, /it was replaced/) && !has(r, /changed on disk since this session first read it/),
    `exit=${r.code}`,
    "the security round's p2b probe (before the fix: the forgery was served and the note misattributed the change)",
  );
}

// ---------------------------------------------------------------------------
// F — duplicate declarations and undispatchable rows
// ---------------------------------------------------------------------------
{
  // Divergent duplicates: the two lookups (registry order, deny-class set) would
  // disagree — first-wins in one, last-wins in the other — which is fail-OPEN in one
  // order (the deny row RUNS, its crash refuses nothing) and OVER-REFUSING in the
  // other. Refused loudly at load, whole file, in the add-only spirit.
  const denyFirst = mkTree({ localFiles: { "rep-crash.js": repoCrash }, localGroups: [grp("Bash", row("rep-crash.js", {}), row("rep-crash.js", { on_incomplete: "continue" }))] });
  const rA = await dispatch(denyFirst, call(denyFirst, "ls"));
  const contFirst = mkTree({ localFiles: { "rep-crash.js": repoCrash }, localGroups: [grp("Bash", row("rep-crash.js", { on_incomplete: "continue" }), row("rep-crash.js", {}))] });
  const rC = await dispatch(contFirst, call(contFirst, "ls"));
  check(
    "32 F: DIVERGENT duplicate declarations on one hook ⇒ REFUSE, in BOTH orders (the fail-open and the over-refusal pole both close)",
    rA.code === 2 && has(rA, /declared TWICE with DIVERGENT on_incomplete/) && rC.code === 2 && has(rC, /DIVERGENT/),
    `deny-first=${rA.code} continue-first=${rC.code}`,
    "the security round's p3 probes (before the fix: [deny,continue] ran the deny row and refused nothing; [continue,deny] refused the call)",
  );
  // Control, same tree shape: IDENTICAL declarations are not divergence — the file
  // loads and the duplicates collapse to ONE run (the host runs one command once).
  const same = mkTree({ localFiles: { "rep.js": REPOOK }, localGroups: [grp("Bash", row("rep.js", { on_incomplete: "continue" }), row("rep.js", { on_incomplete: "continue" }))] });
  const rS = await dispatch(same, call(same, "ls"));
  const runs = (ctxOf(rS).match(/REPO-SPOKE/g) || []).length;
  check("32b F control: IDENTICAL duplicate declarations load and collapse to ONE run", rS.code === 0 && runs === 1, `exit=${rS.code} runs=${runs}`, "identical duplicates refused, or run twice");
}
{
  // A local row for an event this tree's registry does not dispatch can never run:
  // named, with its event, instead of dropped in withLocal's silence.
  const t = mkTree({
    localFiles: { "rep.js": REPOOK },
    localRaw: JSON.stringify({ schema: 1, events: { PreToolUse: { groups: [grp("Bash", "rep.js")] }, PostToolUse: { groups: [grp("Bash", "rep.js")] } } }),
  });
  const r = await dispatch(t, call(t, "ls"));
  const clean = mkTree({ localFiles: { "rep.js": REPOOK }, localGroups: [grp("Bash", "rep.js")] });
  const rc = await dispatch(clean, call(clean, "ls"));
  check(
    "33 F: a row for an event the template registry does NOT dispatch here ⇒ a NOTICE naming the row and the event (control: dispatched events are silent)",
    r.code === 0 && has(r, /does not dispatch PostToolUse in this tree/) && has(r, /PostToolUse \(rep\.js\)/) && !/does not dispatch/.test(ctxOf(rc)),
    `exit=${r.code}`,
    "the correctness round's L2 finding (before the fix: silently dropped)",
  );
}

// ---------------------------------------------------------------------------
// G — a LEGACY row's incomplete-execution contract (the composition pair)
// ---------------------------------------------------------------------------
{
  // A `mode:"legacy"` row is a LOCAL row, so it owes the same fail-closed
  // incomplete-execution contract a supervised one does: a deny-class legacy row
  // that CRASHES must REFUSE at PreToolUse, never contribute nothing silently —
  // the same class FIX 2 closes for supervised rows. The two poles below differ
  // ONLY in the row's own `on_incomplete` declaration, so a detector that refuses
  // everything and one that refuses nothing BOTH red.
  const t = mkTree({
    localFiles: { "legacy-crash.js": repoCrash },
    localGroups: [grp("Bash", row("legacy-crash.js", { mode: "legacy", on_incomplete: "deny" }))],
  });
  const r = await dispatch(t, call(t, "ls"));
  check(
    "34 G: a DENY-class LEGACY row that crashes REFUSES at PreToolUse (exit 2)",
    r.code === 2 && has(r, /incomplete|did not complete|non-zero|crash/i),
    `exit=${r.code}`,
    "the composition pair's RED pole: before the deny-class contract reaches legacy rows, a crashed legacy deny contributes nothing and the call RUNS",
  );
  const t2 = mkTree({
    localFiles: { "legacy-crash.js": repoCrash },
    localGroups: [grp("Bash", row("legacy-crash.js", { mode: "legacy", on_incomplete: "continue" }))],
  });
  const r2 = await dispatch(t2, call(t2, "ls"));
  check(
    '35 G control: the SAME legacy crash with on_incomplete:"continue" does NOT refuse (the pair discriminates)',
    r2.code === 0,
    `exit=${r2.code}`,
    "the pair's GREEN pole: if both poles refused, the RED pole would measure nothing",
  );
}

// ---------------------------------------------------------------------------
// H — the SUPERVISOR path keeps the deny contract (a flagged fail-open, refuted)
// ---------------------------------------------------------------------------
{
  // A regex matcher is not a SIMPLE matcher, so `matcherMatchesWithoutRegex`
  // returns null and the dispatcher hands EVERY local row of that event to the
  // supervisor — which forwards rows as `{hook, file, timeoutMs}` plus matcher
  // bookkeeping, i.e. WITHOUT `mode` and WITHOUT `on_incomplete`. The question
  // these two cases answer, by measurement rather than by reading the code: does a
  // regex-matched event therefore LOSE a repo row's fail-closed declaration?
  // It does NOT — the deny class is re-derived from the dispatcher-side rows (which
  // still carry `on_incomplete`) and matched back onto the supervisor's outcomes by
  // hook. The two poles differ only in that declaration, so both failure directions
  // red: a contract lost on this path, and a contract that refuses everything.
  const crashRow = (extra) => ({ type: "command", command: cmd("legacy-crash.js"), timeout: 5, mode: "legacy", ...extra });
  const t = mkTree({
    localFiles: { "legacy-crash.js": repoCrash, "other.js": REPOOK },
    localGroups: [grp("^Bash$", row("other.js")), grp("Bash", crashRow({ on_incomplete: "deny" }))],
  });
  const r = await dispatch(t, call(t, "ls"));
  check(
    "36 H: on the SUPERVISOR path (a regex matcher routes every local row there) a DENY-class crash still REFUSES",
    r.code === 2 && has(r, /incomplete|did not complete|non-zero|crash/i),
    `exit=${r.code}`,
    "the flagged fail-open: if the forwarded-row drop reached the contract, this crash would contribute nothing and the call would RUN",
  );
  const t2 = mkTree({
    localFiles: { "legacy-crash.js": repoCrash, "other.js": REPOOK },
    localGroups: [grp("^Bash$", row("other.js")), grp("Bash", crashRow({ on_incomplete: "continue" }))],
  });
  const r2 = await dispatch(t2, call(t2, "ls"));
  check(
    '37 H control: the SAME supervisor path and crash with on_incomplete:"continue" does NOT refuse (the pair discriminates)',
    r2.code === 0,
    `exit=${r2.code}`,
    "if both poles refused, case 36 would measure nothing on this path either",
  );
}

// ---------------------------------------------------------------------------
// cleanup + report
// ---------------------------------------------------------------------------
for (const s of sandboxes) {
  try {
    fs.rmSync(s, { recursive: true, force: true });
  } catch {}
}
try {
  fs.rmSync(PIN_ROOT, { recursive: true, force: true });
} catch {}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`  ${tag}  ${c.name}  [${c.detail}]${c.pass ? "" : ` (reds_under: ${c.reds_under})`}\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
