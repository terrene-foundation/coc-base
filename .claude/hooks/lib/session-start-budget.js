"use strict";
/**
 * session-start-budget — keep the MERGED SessionStart additionalContext under the inline
 * limit, with protected production sections before the handover SEED (priority policy
 * implemented below in applySessionStartBudget; F8). Ordinary starts retain seed-first
 * ordering (workspaces/context-budget-2026-10-10/design/CYCLE.md §1.6, M11–M12; shard S4).
 *
 * THE ROOT CAUSE THIS CLOSES, MEASURED (CYCLE.md M11/M12): since the SessionStart
 * dispatcher consolidation every merged SessionStart string ran 11,460–20,119 chars, and
 * Claude Code PERSISTED each one to a file, showing the model a 2 KB preview. The
 * compaction handoff sat LAST in that string, past 15 KB, so the resumed agent never saw
 * it. Per-hook strings of 719–4,240 chars were inlined; the limit is bracketed between
 * 4,240 and 11,460 (INFERENCE, ~10,000). The budget here is 9,500 — under the bracket's
 * floor-by-inference with margin for the JSON envelope.
 *
 * WHAT IT DOES, over the per-detector outcomes BEFORE hook-engine.js::mergeOutcomes joins
 * them (so ordering and size are decided per SECTION, never by cutting a joined string):
 *   1. Protected production sections stay inline ahead of the seed; the seed yields
 *      budget to them (applySessionStartBudget below). Otherwise THE SEED moves to
 *      the FRONT: the section PRODUCED by the loom registry's
 *      compaction-handoff-inject.js row whose first line is boundary-seed.js::
 *      SEED_SENTINEL and whose size is within the seed cap (isSeedSection — never the
 *      first line alone, which any detector can print).
 *   2. Sections are kept inline, in order, while the total — measured with the SAME
 *      separator the merge uses — plus one pointer line for every section not yet placed
 *      stays ≤ the budget.
 *   3. Every section that does not fit is written WHOLE to
 *      `<main-checkout>/.claude/learning/session-start/<session>-<stamp>.md` and replaced by
 *      ONE pointer line naming its hook, its size, its anchor in that file, and its first
 *      line. Nothing is truncated: a cut section reads like a complete one.
 *   4. If the overflow file cannot be written, the pointer line SAYS so (the content is
 *      lost from this start, loudly) — never a silent drop.
 * The function is PURE except for the injected `writeOverflow`.
 */

const SESSION_START_BUDGET_CHARS = 9500;
// MUST equal hook-engine.js::joinBlocks's separator — pinned by the context-boundary
// fixture against the engine's real merge.
const MERGE_SEPARATOR = "\n\n────────\n\n";
const POINTER_PREFIX = "[session-start]";
const POINTER_MAX_CHARS = 300;
// The seed's producer and size cap (boundary-seed.js::INJECT_MAX_CHARS; pinned by the
// context-boundary fixture). Kept as literals so this module loads without the seed libs.
const SEED_HOOK = "compaction-handoff-inject.js";
const SEED_MAX_CHARS = 9000;
// Per-session retention; selection is owned by makeOverflowWriter below.
const OVERFLOW_RETAIN = 20;

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseJson(s) {
  try {
    const j = JSON.parse(String(s || "").trim());
    return isObj(j) ? j : null;
  } catch {
    return null;
  }
}

/** The context text an outcome contributes, mirroring hook-engine.js's harvest rules. */
function contextOf(o) {
  if (!o || o.status === "timeout" || o.status === "skipped") return null;
  const j = parseJson(o.stdout);
  if (j) {
    const h = isObj(j.hookSpecificOutput) ? j.hookSpecificOutput : null;
    if (!Number.isInteger(o.exitCode)) return null;
    return h && typeof h.additionalContext === "string" && h.additionalContext.trim() ? { text: h.additionalContext, json: j } : null;
  }
  if (o.exitCode !== 0) return null;
  const t = String(o.stdout || "").trim();
  return t ? { text: t, json: null } : null;
}

function withContext(o, text, event) {
  const c = contextOf(o);
  const j = c && c.json ? { ...c.json } : { continue: true };
  j.hookSpecificOutput = { ...(isObj(j.hookSpecificOutput) ? j.hookSpecificOutput : {}), hookEventName: event, additionalContext: text };
  return { ...o, stdout: JSON.stringify(j) + "\n" };
}

function hookName(o) {
  return String((o && o.hook) || "(unnamed detector)").replace(/[\r\n]/g, " ").slice(0, 80);
}

function firstLine(t) {
  for (const l of String(t).split("\n")) if (l.trim()) return l.trim();
  return "";
}

function pointerLine(hook, chars, where, first) {
  const head = `${POINTER_PREFIX} ${hook}: ${chars} chars ${where}`;
  const room = POINTER_MAX_CHARS - head.length - 14;
  const f = room > 20 ? ` — first line: ${JSON.stringify(first.slice(0, room))}` : "";
  return `${head}${f}`.slice(0, POINTER_MAX_CHARS);
}

function joinedLength(texts) {
  const t = texts.filter((x) => String(x).trim());
  return t.reduce((a, x) => a + x.length, 0) + Math.max(0, t.length - 1) * MERGE_SEPARATOR.length;
}

/**
 * Is this outcome THE seed section? M2: identified by its PRODUCER — the loom registry's
 * `compaction-handoff-inject.js` row (a repo-owned row is tagged `origin:"local"` by the
 * dispatcher and never qualifies) — AND the sentinel first line AND a size within the
 * seed cap. A first line alone is content any SessionStart detector can print, so it can
 * never buy a section the seed's budget exemption.
 */
function isSeedSection(o, text, { sentinel, seedHook, seedMaxChars }) {
  if (typeof sentinel !== "string" || !o || o.origin === "local") return false;
  if (String(o.hook || "") !== seedHook) return false;
  if (firstLine(text) !== sentinel) return false;
  return text.length <= seedMaxChars;
}

/**
 * @param {object[]} outcomes  per-detector outcomes (hook-engine shape)
 * @param {{budget?:number, sentinel:string, seedHook?:string, seedMaxChars?:number, writeOverflow:(sections:{hook:string,text:string}[])=>({ok:true,path:string}|{ok:false,reason:string}), event?:string}} opts
 * @returns {{outcomes:object[], report:{total:number, moved:number, seedFirst:boolean, overflow:string|null, error:string|null, overBudget:boolean}}}
 */
function applySessionStartBudget(outcomes, { budget = SESSION_START_BUDGET_CHARS, sentinel, seedHook = SEED_HOOK, seedMaxChars = SEED_MAX_CHARS, writeOverflow, event = "SessionStart" } = {}) {
  const list = Array.isArray(outcomes) ? outcomes.slice() : [];
  // Production producers (anchored by symbol — line numbers rotted on insertion):
  // dispatch-main.js::main (each `hook: "dispatch.js"` outcome it pushes);
  // multi-operator-sessionstart.js::buildFullBanner; posture-gate.js::main (its
  // `event === "SessionStart"` branch); settings-deny-drift-guard.js (header comment).
  // Protect whole outcomes: their context has no authenticated sub-section metadata.
  const protectedHooks = new Set([
    "dispatch.js", "multi-operator-sessionstart.js", "posture-gate.js",
    "settings-deny-drift-guard.js", "genesis-anchor-guard.js",
    "signing-mutation-guard.js", "integrity-guard.js",
    "cross-ecosystem-disclosure-guard.js", "tenant-upsert-guard.js",
    "rebase-content-loss-guard.js",
  ]);
  const sections = [];
  let seedSeen = false;
  list.forEach((o, i) => {
    const c = contextOf(o);
    if (!c) return;
    const seed = !seedSeen && isSeedSection(o, c.text, { sentinel, seedHook, seedMaxChars });
    if (seed) seedSeen = true;
    const h = c.json && c.json.hookSpecificOutput;
    const refusal = !!c.json && (c.json.continue === false || c.json.decision === "block" ||
      (isObj(h) && h.permissionDecision === "deny"));
    const protectedSection = refusal || (o.origin !== "local" && protectedHooks.has(String(o.hook || "")));
    sections.push({ i, o, text: c.text, seed, protectedSection });
  });
  const protectedSections = sections.filter((s) => s.protectedSection);
  const ordinary = sections.filter((s) => !s.protectedSection);
  const ordered = [...protectedSections, ...ordinary.filter((s) => s.seed), ...ordinary.filter((s) => !s.seed)];
  const report = { total: 0, moved: 0, seedFirst: !!(ordered[0] && ordered[0].seed), overflow: null, error: null, overBudget: false };

  // Preserve non-speaking outcomes in their slots; order the speaking outcomes by priority.
  const bySlot = new Map(sections.map((s, k) => [s.i, ordered[k].o]));
  let out = list.map((o, i) => bySlot.has(i) ? bySlot.get(i) : o);
  const texts = ordered.map((s) => s.text);
  if (joinedLength(texts) <= budget) {
    report.total = joinedLength(texts);
    return { outcomes: out, report };
  }

  // Greedy placement with a reservation: a section is inlined only if the pointer lines of
  // every LATER section still fit after it.
  const PLACEHOLDER_PTR = POINTER_MAX_CHARS;
  const placed = [];
  let used = 0;
  ordered.forEach((s, k) => {
    const sep = placed.length ? MERGE_SEPARATOR.length : 0;
    const reserve = (ordered.length - k - 1) * (PLACEHOLDER_PTR + MERGE_SEPARATOR.length);
    // Security/fault/posture/tamper sections cannot be replaced by a pointer.
    // A seed retains its old exemption only when no protected section needs the budget.
    if (s.protectedSection || (s.seed && !protectedSections.length) || used + sep + s.text.length + reserve <= budget) {
      placed.push({ s, inline: true });
      used += sep + s.text.length;
    } else {
      placed.push({ s, inline: false });
      used += sep + PLACEHOLDER_PTR;
    }
  });

  // The final texts for a given placement + overflow outcome: per-section pointers, or ONE
  // collapsed line when those do not fit.
  const render = (w) => {
    const moved = placed.filter((p) => !p.inline);
    const err = w && w.ok ? null : (w && w.reason) || "overflow not written";
    const replaced = new Map();
    let anchor = 0;
    for (const p of moved) {
      anchor++;
      const where = !err ? `moved to ${w.path}#section-${anchor} (read on demand)` : `NOT SAVED (${err}) — this section's output was DROPPED from this start`;
      replaced.set(p.s.o, pointerLine(hookName(p.s.o), p.s.text.length, where, firstLine(p.s.text)));
    }
    let finalTexts = placed.map((p) => (p.inline ? p.s.text : replaced.get(p.s.o)));
    if (joinedLength(finalTexts) > budget) {
      let first = true;
      const chars = moved.reduce((a, p) => a + p.s.text.length, 0);
      for (const p of moved) {
        replaced.set(p.s.o, first ? `${POINTER_PREFIX} ${moved.length} sections (${chars} chars) ${!err ? `moved to ${w.path} (read on demand)` : `NOT SAVED (${err}) — DROPPED from this start`}`.slice(0, POINTER_MAX_CHARS) : "");
        first = false;
      }
      finalTexts = placed.map((p) => (p.inline ? p.s.text : replaced.get(p.s.o)));
    }
    return { replaced, total: joinedLength(finalTexts), err };
  };

  // Final enforcement demotes the seed first when protected sections need room.
  // Protected content alone may exceed budget: retain it verbatim and report loudly.
  const WORST_PATH = { ok: true, path: "x".repeat(POINTER_MAX_CHARS) };
  for (;;) {
    if (render(WORST_PATH).total <= budget) break;
    const cand = placed.filter((p) => p.inline && !p.s.protectedSection && (!p.s.seed || protectedSections.length))
      .sort((x, y) => Number(y.s.seed) - Number(x.s.seed) || y.s.text.length - x.s.text.length)[0];
    if (!cand) break;
    cand.inline = false;
  }

  const movedSecs = placed.filter((p) => !p.inline).map((p) => ({ hook: hookName(p.s.o), text: p.s.text }));
  let w;
  try {
    w = typeof writeOverflow === "function" ? writeOverflow(movedSecs) : { ok: false, reason: "no overflow writer" };
  } catch (e) {
    w = { ok: false, reason: (e && e.message) || "overflow write threw" };
  }
  if (!w || w.ok !== true) report.error = (w && w.reason) || "overflow not written";
  else report.overflow = w.path;
  const r = render(w);
  report.moved = r.replaced.size;
  report.total = r.total;
  if (r.total > budget) {
    report.overBudget = true;
    report.error = `${report.error ? `${report.error}; ` : ""}the merged SessionStart context is ${r.total} chars, OVER the ${budget} budget even with every movable section moved`;
  }
  out = out.map((o) => (r.replaced.has(o) ? withContext(o, r.replaced.get(o), event) : o));
  return { outcomes: out, report };
}

/** Render the overflow file body: one anchored section per moved hook output. */
function renderOverflow(sections, { stamp, source }) {
  const parts = [`# SessionStart overflow — ${stamp} (source=${source || "unknown"})`, "", "Sections moved out of the inline SessionStart context to keep it under the inline limit. Each is the hook's WHOLE output.", ""];
  sections.forEach((s, k) => {
    parts.push(`<a id="section-${k + 1}"></a>`, `## ${k + 1}. ${s.hook} (${s.text.length} chars)`, "", s.text, "");
  });
  return parts.join("\n");
}

/**
 * The real overflow writer: `<main-checkout>/.claude/learning/session-start/<key>-<stamp>.md`,
 * contained the same way the meter's learning dirs are (lib/context-meter.js::
 * resolveLearningDir — canonical comparison, symlinked dir refused), gitignored, written
 * exclusively. Returns the function applySessionStartBudget calls.
 */
function makeOverflowWriter({ repoDir, sessionId, source, nowIso }) {
  return (sections) => {
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const meter = require("./context-meter.js");
    const d = meter.resolveLearningDir(repoDir, "session-start");
    if (!d.ok) return { ok: false, reason: d.reason };
    const stamp = String(nowIso || new Date().toISOString()).replace(/[:.]/g, "-");
    const key = meter.sessionKey(typeof sessionId === "string" && sessionId ? sessionId : "unknown");
    const file = path.join(d.dir, `${key}-${stamp}.md`);
    try {
      // LOW4: the directory is checked BEFORE anything is written into it (mkdir does not
      // follow a final-component symlink into existence, and lstat refuses one).
      fs.mkdirSync(d.dir, { recursive: true });
      const dst = fs.lstatSync(d.dir);
      if (dst.isSymbolicLink() || !dst.isDirectory()) return { ok: false, reason: "session-start dir is a symlink or not a directory — refusing" };
      const ignore = path.join(d.dir, ".gitignore");
      try {
        fs.writeFileSync(ignore, "*\n", { flag: "wx" });
      } catch (e) {
        if (!e || e.code !== "EEXIST") return { ok: false, reason: `.gitignore could not be written (${(e && e.code) || "error"})` };
      }
      // The ignore must actually ignore everything here: a pre-existing file is VERIFIED.
      const ist = fs.lstatSync(ignore);
      const itext = ist.isFile() && ist.size <= 4096 ? fs.readFileSync(ignore, "utf8") : "";
      if (!/^\*\s*$/m.test(itext)) return { ok: false, reason: "session-start/.gitignore does not ignore `*` — refusing to write session context where it could be committed" };
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
      fs.writeFileSync(tmp, renderOverflow(sections, { stamp: nowIso, source }), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, file);
      // Retention is confined to this session's exact key (lines below), never its peers.
      try {
        const mine = fs.readdirSync(d.dir).filter((n) => n.startsWith(`${key}-`) && /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/.test(n.slice(key.length + 1))).sort();
        for (const n of mine.slice(0, Math.max(0, mine.length - OVERFLOW_RETAIN))) {
          const p = path.join(d.dir, n);
          if (fs.lstatSync(p).isFile()) fs.unlinkSync(p);
        }
      } catch {
        /* retention is best-effort; the write itself succeeded */
      }
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, reason: (e && e.code) || (e && e.message) || "write failed" };
    }
  };
}

module.exports = {
  makeOverflowWriter,
  SESSION_START_BUDGET_CHARS,
  MERGE_SEPARATOR,
  POINTER_PREFIX,
  POINTER_MAX_CHARS,
  SEED_HOOK,
  SEED_MAX_CHARS,
  OVERFLOW_RETAIN,
  isSeedSection,
  contextOf,
  applySessionStartBudget,
  renderOverflow,
};
