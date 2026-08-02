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

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { pathToFileURL } from "node:url";

// #1309 (redteam P3.2) — atomic write of the security-critical deny contract:
// write a sibling temp then rename() over the target, so a crash/kill mid-write
// cannot truncate settings.json into a malformed state (which would then defeat
// the L3 drift-guard's next-session self-heal, per its fail-open-on-malformed).
// rename() within the same directory is atomic on POSIX + Windows.
function atomicWriteFileSync(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Tool names whose DENY-matcher FORM no longer matches file edits in Claude
// Code — every file-editing tool is now covered by the `Edit` matcher alone.
const REWRITE_TOOLS = ["Write", "NotebookEdit"];
const CANONICAL_TOOL = "Edit";

// ── #1309 L3 — CANONICAL_STATE_DENY (single source of truth) ────────────────
// The canonical set of `permissions.deny` entries every consuming settings.json
// MUST carry to fence the trust-posture state files at the FILE-TOOL layer. This
// constant is the SSOT the SessionStart drift-guard (settings-deny-drift-guard.js)
// restores TO: it reads settings.json's permissions.deny, and AUTO-RESTORES any
// canonical entry that was stripped (external editor, Bash) — the presence-drift
// half the FORM reconciler above does NOT cover (that handles Write→Edit form,
// not deletion). settings.json DEFINES these guards but was itself unprotected
// (#1309); L2 (validate-bash-command.js STATE_PATH_RX) fences the Bash vector,
// L3 (this constant + the drift-guard) fences the external-editor / file-tool
// strip that L2 cannot see. L1 (a blanket `Edit(.claude/settings.json)` deny)
// is DELIBERATELY OMITTED: unlike posture.json (hook-only writers), settings.json
// is legitimately edited by the settings-manager agent / `/settings` via the Edit
// tool, which a deny would break (evidence: settings-manager.md tools: Read,
// Write, Edit; posture-gate.js "primary fence" note confirms deny fires under
// bypassPermissions) — so L2+L3 are the load-bearing fix.
//
// EXTENDING (documented 2-site SSOT, matching the STATE_PATH_RX pattern): a new
// state-file guard updates BOTH this constant AND the `permissions.deny` array in
// every settings.json. Keep this list in sync with the deny block loom ships;
// the drift-guard treats anything here-but-missing as a strip to restore.
//
// ── #1399 — why `.claude/VERSION` is NOT in this list (DELIBERATE) ───────────
// #1399 asked for `.claude/VERSION` on BOTH state fences: the Bash lane
// (`validate-bash-command.js::STATE_PATH_RX`) and this file-tool deny floor.
// The Bash half LANDED (see that file's § "VERSION (#1399 …)"). This half is
// DECLINED, and the decline is recorded here — not merely omitted — so a future
// reader does not "close the asymmetry" and break three shipped flows.
//
// Every entry below shares one property: its ONLY legitimate writers are HOOKS
// (in-process `fs.writeFileSync`, which no `Edit()` deny can reach) or a named
// ceremony. `.claude/VERSION` does NOT. It has TWO Edit/Write-TOOL writers on
// documented HAPPY paths, plus ONE on a HALT/error-recovery path — none with a
// helper script to route through. Each quotation below is verbatim at the single
// line cited (do NOT collapse two sites into one quote):
//
//   HAPPY PATH — either one alone defeats a flat deny:
//   1. `commands/sync-from-template.md:42`, verbatim:
//        "6. Update `.claude/VERSION` upstream block (template version +
//         `synced_at`)."
//      Step 5 names its script (`reconcile-settings-deny.mjs`); Step 6 names
//      none. Runs at EVERY downstream consumer on EVERY pull — widest blast
//      radius here, and DISPOSITIVE on its own.
//   2. `skills/30-claude-code-patterns/multi-cli-migration.md:488`, verbatim:
//        "- **VERSION (Step 2 shape):** write a fresh `.claude/VERSION` with
//         `type: coc-project`, …"
//      Its command-file counterpart `commands/migrate.md:49` states the same
//      Step-2 write in DIFFERENT words ("Update `.claude/VERSION`
//      `upstream.template` → `<sister>`, …") — the "write a fresh" phrasing
//      appears at :488 ONLY, never in migrate.md. Second genuine break.
//
//   HALT PATH — real, but NOT a write the command performs on a happy path;
//   listed for completeness, and the ruling does not rest on it:
//   3. `commands/codify.md:128` (Step-7c HALT text) + the same sentence at
//      `skills/30-claude-code-patterns/sync-flow.md:203` — an error-recovery
//      instruction to the OPERATOR: "set `upstream.template` in
//      `.claude/VERSION` to your template's name, … re-run /codify". Step 7c's
//      own write target is `.claude/.proposals/latest.yaml`; every OTHER
//      VERSION mention in codify.md (51, 124, 126) is a `::type` READ.
// (`bin/stamp-template-version.mjs` is NOT a fourth writer for this purpose: it
// stamps a TARGET worktree's VERSION from the loom side at `/sync-to-use`
// Gate-2 via `--worktree`, and is an in-process fs write either way.)
//
// A flat `Edit(.claude/VERSION)` deny would therefore hard-break all three. This
// is the SAME reasoning that omits settings.json's own L1 blanket deny (see the
// L1 paragraph above: legitimately edited by settings-manager / `/settings` via
// the Edit tool) — precedent, not an exception invented here.
//
// This is a RULING OFFERED FOR RATIFICATION, not a settled contract. What changes
// if it is overridden: the deny lands, `CANONICAL_STATE_DENY` goes 11 → 12 at all
// four parity sites, and the three flows above MUST first be routed through a
// by-path ceremony script (the residual-(c) licensed-writer pattern
// `/whoami --register` and `/certify` already use) — a separate shard, because it
// is a new script + three command-doc rewrites + the consumer-lane distribution
// allowlist (`sync-tier-aware.mjs`) + tests.
//
// SCOPE HONESTY — the cost of this decline is BOUNDED, and the bound is tracked.
// Landing the Bash half alone leaves the Edit-tool agent-write vector open; that is
// the residual this decline accepts. What it does NOT leave open, because no fence
// ever covered it, is the ACCIDENT vector (a mis-merged / mis-synced VERSION): that
// arrives via `git merge` or a sync script, which is NEITHER a Bash tool call NOR an
// Edit tool call, so BOTH fences #1399 prescribes are blind to it by construction.
// That path needs a class-vs-manifest CROSS-CHECK, not a fence, and is tracked as
// #1402 (`emit.mjs` has one; `emit-cli-artifacts.mjs` + `emit-coc.mjs` have none —
// measured 0/0 against emit.mjs's 3/3). So the decline trades one agent-write lane
// for two working happy-path flows, with the genuinely-uncovered path named and
// owned elsewhere — not silently absorbed here.
//
// INHERITED OVER-BLOCK COST (recorded, NOT introduced here; do not "fix" it in this
// shard). The Layer-3 `block` this path inherits rests on a "prose-FP risk ≈ 0"
// premise that `state-file-write-guard.md` itself records as having been found FALSE
// once already (#1363). Prose frequency measured over the shipped-doc corpus
// (`.claude/{commands,skills,rules,agents,guides}`) at this head:
//
//     .claude/VERSION                 95 mentions / 23 files
//     .claude/settings.json           58 mentions / 26 files
//     .claude/learning/posture.json   15 mentions / 12 files
//
// i.e. VERSION is the MOST prose-mentioned protected path in the corpus — ~1.6× the
// settings.json incumbent and ~6.3× posture.json. The two recorded OPEN residuals now
// reach it: (k) the UNANCHORED match, so a `/tmp/<sandbox>/.claude/VERSION` write
// blocks; and (l) a heredoc-authored report that merely QUOTES a write example. Both
// are documented as PASS at base and BLOCK at this head. The cost is concrete, not
// theoretical: (l) is recorded as having caused three independent blocks in ONE round,
// every one of them on work VERIFYING the guard, and in this wave's own review a
// symlink-containment probe could not be staged because (k) blocked its sandbox path.
// Extending that to the corpus's most-documented path RAISES the self-sealing cost, so
// this argues for bumping (l)'s priority on the #1363 shard. Direction is fail-CLOSED
// throughout (over-block, never fail-open), which is why it is recorded rather than
// treated as a blocker.
export const CANONICAL_STATE_DENY = [
  "Edit(.claude/learning/posture.json)",
  "Edit(.claude/learning/posture.json.bak)",
  "Edit(.claude/learning/posture.json.tmp.*)",
  "Edit(.claude/learning/violations.jsonl)",
  "Edit(.claude/learning/violations.jsonl.*)",
  "Edit(.claude/learning/.initialized)",
  "Edit(.claude/learning/presence-mechanism.json)",
  "Edit(.claude/operators.roster.json)",
  "Edit(.claude/learning/coordination-log.jsonl)",
  "Edit(.claude/learning/.heartbeat-cache*)",
  "Edit(.claude/learning/.session-end-cache*)",
];

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

/**
 * #1309 L3 — restore any stripped CANONICAL_STATE_DENY entries into a deny array.
 * PRESENCE-drift only: adds back canonical entries that are MISSING; never
 * reorders or drops existing entries, and preserves any operator-added extras.
 * Deterministic + idempotent: a deny array already containing every canonical
 * entry (in any order, with any extras) is returned unchanged (changed:false);
 * a stripped array gets its missing canonical entries PREPENDED in canonical
 * order (so they sit grouped with their surviving siblings). Distinct from
 * reconcileDenyArray (which handles the Write()/NotebookEdit()→Edit() FORM); this
 * handles DELETION of the guard entirely.
 * @param {string[]} deny
 * @returns {{ deny: string[], changed: boolean, restored: string[] }}
 */
export function restoreCanonicalDenyArray(deny) {
  const arr = Array.isArray(deny) ? deny.slice() : [];
  const present = new Set(arr.filter((e) => typeof e === "string"));
  const restored = CANONICAL_STATE_DENY.filter((e) => !present.has(e));
  if (restored.length === 0) return { deny: arr, changed: false, restored: [] };
  return { deny: restored.concat(arr), changed: true, restored };
}

/**
 * Restore stripped canonical deny entries inside a settings.json TEXT, preserving
 * key order, indentation and trailing newline (same write discipline as
 * reconcileSettingsText). Recreates permissions / permissions.deny if the key was
 * deleted entirely. Throws on unparseable JSON (fail-loud). Returns unchanged text
 * when nothing was stripped.
 * @param {string} text
 * @returns {{ text: string, changed: boolean, restored: string[] }}
 */
export function restoreCanonicalDenyInText(text) {
  const obj = JSON.parse(text);
  const deny = obj?.permissions?.deny;
  const { deny: newDeny, changed, restored } = restoreCanonicalDenyArray(deny);
  if (!changed) return { text, changed: false, restored: [] };
  if (!obj.permissions || typeof obj.permissions !== "object") obj.permissions = {};
  obj.permissions.deny = newDeny;
  const indent = detectIndent(text);
  let out = JSON.stringify(obj, null, indent);
  if (text.endsWith("\n")) out += "\n";
  return { text: out, changed: true, restored };
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
  atomicWriteFileSync(file, result.text);
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
