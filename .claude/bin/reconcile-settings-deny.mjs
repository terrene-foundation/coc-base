#!/usr/bin/env node
/*
 * ============================================================================
 *  reconcile-settings-deny — settings.json deny-rule FORM reconciler
 * ============================================================================
 *
 *  Claude Code stopped honoring `Write(<path>)` / `NotebookEdit(<path>)`
 *  permission-DENY matchers: only `Edit(<path>)` now covers ALL three
 *  file-editing tools (Edit / Write / NotebookEdit). A consumer whose
 *  `.claude/settings.json` still carries state-file deny rules in the stale
 *  `Write(...)` / `NotebookEdit(...)` form therefore ships a gate that no
 *  longer matches — CC surfaces an init error on every inheriting session AND
 *  the guarded state files (posture.json, violations.jsonl, the roster, the
 *  coordination log, the sentinels) are left un-denied.
 *
 *  loom's OWN settings.json was fixed to the `Edit(...)` form, but that fix
 *  never reached consumers: settings.json is EXCLUDED from the general
 *  artifact sync and reconciled only by special handlers, and neither handler
 *  touched the deny-rule FORM. This deterministic reconciler is the fix that
 *  both handlers now invoke:
 *    - `/sync-to-use`  (coc-sync.md Step 6) runs it on each template  → templates
 *      distribute the corrected form.
 *    - `/sync-from-template` runs it on the CONSUMER's OWN settings.json → already
 *      deployed consumers self-heal on their next pull.
 *
 *  TRANSFORM CONTRACT (deterministic, idempotent — NOT agent-improvised):
 *    Operates on `permissions.deny` ONLY. For each entry:
 *      • `Write(<x>)`        → `Edit(<x>)`
 *      • `NotebookEdit(<x>)` → `Edit(<x>)`
 *      • bare `Write` / `NotebookEdit` (no argument) → `Edit`
 *      • every other entry (Edit(…), Bash(…), Read(…), MultiEdit(…), …) → untouched
 *    Then DEDUP the deny array by exact string, first-occurrence wins, so
 *    `Write(x)` + `Edit(x)` + `NotebookEdit(x)` collapse to a single `Edit(x)`.
 *    Rationale: for a DENY rule `Write(x)`→`Edit(x)` only ever BROADENS the deny
 *    (fail-safe) while making it actually match — the transform CC's own error
 *    prescribes. Exact-string dedup removes only redundant duplicates; every
 *    DISTINCT deny survives, so the guarded set is never weakened.
 *
 *    NEVER touched: `permissions.allow`, `hooks[]`, or any other key. Key order
 *    + indentation + trailing-newline are preserved; an already-clean file is
 *    left byte-for-byte unchanged (no reformat). Idempotent: a second run over
 *    a reconciled file produces ZERO change. CAVEAT: a CHANGED file is
 *    re-serialized via JSON.stringify — values are preserved but the formatting
 *    of unrelated blocks may normalize (e.g. an inline single-line `hooks`
 *    object expands to multi-line); an already-clean file is never re-serialized.
 *
 *  CLI:
 *    node .claude/bin/reconcile-settings-deny.mjs --check <settings.json>
 *        exit 0 if the deny array is already canonical (nothing `--write` would
 *        change, INCLUDING a dedup-only difference); exit 1 (and list the stale
 *        and/or collapsible entries) otherwise. No write. A MISSING file is a
 *        benign no-op (exit 0). Malformed JSON is fail-loud (exit 2).
 *    node .claude/bin/reconcile-settings-deny.mjs --write <settings.json>
 *        apply the transform in place (writes only when the deny array changes).
 *
 *  The core transform is exported (`reconcileDenyArray`, `reconcileSettingsText`)
 *  for the validator (validate-emit.mjs `settings-deny-rule-form` check) + tests.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Tool names whose DENY-matcher FORM no longer matches file edits in Claude
// Code — every file-editing tool is now covered by the `Edit` matcher alone.
const REWRITE_TOOLS = ["Write", "NotebookEdit"];
const CANONICAL_TOOL = "Edit";

// Match a single permission-matcher entry: `Tool` or `Tool(<specifier>)`.
// `[A-Za-z]+` is the tool name; the optional `(...)` captures the specifier
// greedily to the LAST `)` so nested-paren specifiers survive intact.
const MATCHER_RE = /^([A-Za-z]+)(\((.*)\))?$/;

/**
 * Rewrite a single deny-matcher string to its canonical form.
 * Returns the (possibly unchanged) string. Non-matching / non-target entries
 * are returned verbatim.
 */
export function rewriteDenyEntry(entry) {
  if (typeof entry !== "string") return entry;
  const m = entry.match(MATCHER_RE);
  if (!m) return entry; // malformed / unrecognized shape — leave untouched
  const tool = m[1];
  if (!REWRITE_TOOLS.includes(tool)) return entry;
  const specifier = m[2]; // includes the parens, or undefined for a bare tool
  return specifier ? `${CANONICAL_TOOL}${specifier}` : CANONICAL_TOOL;
}

/**
 * Reconcile a `permissions.deny` array.
 * @param {string[]} deny
 * @returns {{ deny: string[], changed: boolean, offending: string[], removed: string[] }}
 *   deny      — the reconciled array (rewritten + exact-string deduped)
 *   changed   — true iff the reconciled array differs from the input (this is the
 *               single "would --write mutate?" signal — it accounts for BOTH the
 *               Write()/NotebookEdit() rewrite AND a dedup-only collapse)
 *   offending — the input entries that carried a stale Write()/NotebookEdit() form
 *   removed   — the (post-rewrite) entries dropped as exact-string duplicates
 *               (a dedup-only file has empty `offending` but non-empty `removed`)
 */
export function reconcileDenyArray(deny) {
  if (!Array.isArray(deny)) return { deny, changed: false, offending: [], removed: [] };
  const offending = [];
  const rewritten = deny.map((e) => {
    const out = rewriteDenyEntry(e);
    if (out !== e) offending.push(e);
    return out;
  });
  // Exact-string dedup, first-occurrence wins (stable order).
  const seen = new Set();
  const deduped = [];
  const removed = [];
  for (const e of rewritten) {
    const key = typeof e === "string" ? e : JSON.stringify(e);
    if (seen.has(key)) {
      removed.push(e);
      continue;
    }
    seen.add(key);
    deduped.push(e);
  }
  const changed =
    deduped.length !== deny.length || deduped.some((e, i) => e !== deny[i]);
  return { deny: deduped, changed, offending, removed };
}

// Detect the indent unit of a JSON document (spaces of the first indented
// line), defaulting to two spaces. Preserves the file's existing formatting.
function detectIndent(text) {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return 2;
  const ws = m[1];
  if (ws.includes("\t")) return "\t";
  return ws.length;
}

/**
 * Reconcile the deny array inside a settings.json TEXT, preserving key order,
 * indentation and trailing-newline. Returns the (possibly unchanged) text plus
 * a report. Throws on unparseable JSON (fail-loud — a malformed settings.json
 * is a caller problem, not something to silently rewrite).
 * @param {string} text
 * @returns {{ text: string, changed: boolean, offending: string[], removed: string[] }}
 */
export function reconcileSettingsText(text) {
  const obj = JSON.parse(text);
  const deny = obj?.permissions?.deny;
  if (!Array.isArray(deny)) {
    return { text, changed: false, offending: [], removed: [] };
  }
  const { deny: newDeny, changed, offending, removed } = reconcileDenyArray(deny);
  if (!changed) {
    return { text, changed: false, offending, removed };
  }
  obj.permissions.deny = newDeny;
  const indent = detectIndent(text);
  let out = JSON.stringify(obj, null, indent);
  if (text.endsWith("\n")) out += "\n";
  return { text: out, changed: true, offending, removed };
}

function usage() {
  process.stderr.write(
    "usage: reconcile-settings-deny.mjs (--check | --write) <settings.json>\n",
  );
}

export function main(argv) {
  const mode = argv[0];
  const file = argv[1];
  if ((mode !== "--check" && mode !== "--write") || !file) {
    usage();
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    // A MISSING settings.json is a benign no-op (exit 0): a consumer whose
    // /sync-from-template self-heal step runs before it has a settings.json
    // has nothing to reconcile, and hard-erroring there would break the pull.
    // Any OTHER read error (permission, is-a-directory) stays fail-loud.
    if (e.code === "ENOENT") {
      process.stdout.write(`reconcile-settings-deny: ${file} absent — nothing to reconcile\n`);
      return 0;
    }
    process.stderr.write(`reconcile-settings-deny: cannot read ${file}: ${e.message}\n`);
    return 2;
  }
  let result;
  try {
    result = reconcileSettingsText(text);
  } catch (e) {
    process.stderr.write(`reconcile-settings-deny: ${file} does not parse as JSON: ${e.message}\n`);
    return 2;
  }
  const staleCount = result.offending.length;
  const dupCount = result.removed.length;
  if (mode === "--check") {
    if (!result.changed) {
      process.stdout.write(`reconcile-settings-deny: ${file} CLEAN (deny rules canonical)\n`);
      return 0;
    }
    // Exit 1 iff --write WOULD mutate the file — a rewrite OR a dedup-only
    // collapse. Report both dimensions so --check and --write never disagree.
    process.stdout.write(
      `reconcile-settings-deny: ${file} STALE — ${staleCount} stale Write()/NotebookEdit() deny entr${
        staleCount === 1 ? "y" : "ies"
      } + ${dupCount} collapsible duplicate${dupCount === 1 ? "" : "s"} (--write would change this file):\n`,
    );
    for (const o of result.offending) process.stdout.write(`  rewrite: ${o}\n`);
    for (const r of result.removed) process.stdout.write(`  dedup:   ${r}\n`);
    return 1;
  }
  // --write
  if (!result.changed) {
    process.stdout.write(`reconcile-settings-deny: ${file} already canonical — no change\n`);
    return 0;
  }
  writeFileSync(file, result.text);
  process.stdout.write(
    `reconcile-settings-deny: ${file} reconciled — rewrote ${staleCount} stale + deduped ${dupCount} duplicate deny entr${
      staleCount + dupCount === 1 ? "y" : "ies"
    } to the Edit() form\n`,
  );
  return 0;
}

// Run as a CLI only when invoked directly (not when imported by tests/validator).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
