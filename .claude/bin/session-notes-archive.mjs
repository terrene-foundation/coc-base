#!/usr/bin/env node
/**
 * session-notes-archive — move HISTORY out of the two per-operator continuity
 * surfaces so what every session reads stays current-only (context-budget S5/S6).
 *
 *   notes  (default)  `.session-notes.d/` history files (overflow / handoff /
 *                     next-session / traps / queued) → `.session-notes.archive/<owner>/`
 *                     via session-notes-layout.js::archiveHistoryFragments, then
 *                     regenerates the aggregate and prints its bytes.
 *   waves --id <id>   CLOSED wave sections of `.wave-tracker.d/<id>.md` →
 *                     `.wave-tracker.d/archive/<id>.md` via
 *                     wave-tracker-layout.js::archiveClosedWaves.
 *
 * DRY-RUN unless --apply. Nothing is deleted: moves are link-then-unlink with a
 * sha256 re-check at the destination; wave sections are written to the archive
 * and re-read before the tracker is rewritten.
 *
 * Exit: 0 clean (plan, or applied with nothing refused) · 2 REFUSED (a file not
 * moved, a conservation miss, or a tracker still over its ceiling — not a pass) ·
 * 64 usage.
 *
 * usage: session-notes-archive.mjs [notes|waves] [--root <dir>] [--id <id>] [--apply] [--json]
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "hooks", "lib");
const layout = require(path.join(LIB, "session-notes-layout.js"));
const waves = require(path.join(LIB, "wave-tracker-layout.js"));

function usage(msg) {
  if (msg) process.stderr.write(`session-notes-archive: ${msg}\n`);
  process.stderr.write(
    "usage: session-notes-archive.mjs [notes|waves] [--root <dir>] [--id <id>] [--apply] [--json]\n",
  );
  process.exit(64);
}

const argv = process.argv.slice(2);
let mode = "notes";
let root = process.cwd();
let id = null;
let apply = false;
let json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "notes" || a === "waves") mode = a;
  else if (a === "--apply") apply = true;
  else if (a === "--json") json = true;
  else if (a === "--root") root = argv[++i] || usage("--root needs a value");
  else if (a === "--id") id = argv[++i] || usage("--id needs a value");
  else if (a === "-h" || a === "--help") usage();
  else usage(`unknown argument: ${a}`);
}
root = path.resolve(root);

if (mode === "waves") {
  if (!id) usage("waves needs --id <display_id>");
  const r = waves.archiveClosedWaves(root, id, { apply });
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else {
    const lines = [
      `wave tracker ${id}: ${r.before_lines ?? "?"} → ${r.after_lines ?? "?"} lines (ceiling ${r.ceiling}) ${apply ? (r.applied ? "APPLIED" : "NOT APPLIED") : "DRY-RUN"}`,
      ...(r.archived || []).map((s) => `  archive  ${s.lines}L  [${s.why}]  ${s.heading}`),
      ...(r.current || []).map((s) => `  keep     ${s.lines}L  ${s.heading}`),
    ];
    if (!r.ok) lines.push(`REFUSED: ${r.error} — ${r.reason}`);
    process.stdout.write(lines.join("\n") + "\n");
  }
  process.exit(r.ok ? 0 : 2);
}

const r = layout.archiveHistoryFragments(root, { apply });
let agg = null;
if (apply) agg = layout.regenerateAggregate(root);
if (json) {
  process.stdout.write(JSON.stringify({ archive: r, aggregate: agg }, null, 2) + "\n");
} else {
  const total = r.moves.reduce((s, m) => s + m.bytes, 0);
  const lines = [
    `${apply ? "APPLIED" : "DRY-RUN"}: ${r.moves.length} history file(s), ${total} B; current fragments kept: ${r.current.join(", ") || "none"}`,
    ...r.moves.map((m) => `  ${m.status.padEnd(16)} ${m.from} → ${m.to}  ${m.bytes} B  sha256=${m.sha256.slice(0, 16)}`),
    ...r.refused.map((x) => `  REFUSED          ${x.name}: ${x.reason}`),
    `conservation: ${r.conservation.conserved}/${r.conservation.before} re-hashed at destination${r.conservation.lost.length ? `; NOT conserved: ${r.conservation.lost.join(", ")}` : ""}`,
  ];
  if (r.dangling_pointers.length) {
    lines.push(`pointers to repoint (${r.dangling_pointers.length}) — fragments are single-writer, so their owner repoints them:`);
    for (const d of r.dangling_pointers) lines.push(`  ${d.fragment}:${d.line}  ${d.target} → ${d.now}`);
  }
  if (agg) {
    lines.push(
      agg.ok
        ? `aggregate: ${agg.bytes} B (budget ${agg.budget} B), ${agg.fragment_count} current fragment(s)`
        : `aggregate: REFUSED — ${agg.error}: ${agg.reason}`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}
process.exit(r.ok && (!agg || agg.ok) ? 0 : 2);
