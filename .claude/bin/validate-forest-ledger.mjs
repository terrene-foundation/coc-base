#!/usr/bin/env node
/*
 * ============================================================================
 *  Forest-Ledger Conformance Validator — journal/0089..0095 (Option B)
 * ============================================================================
 *
 *  Mechanical gate for the "Outstanding ledger (forest)" section of a
 *  `.session-notes` file (contract: `.claude/commands/wrapup.md`
 *  § Outstanding ledger reconciliation).
 *
 *  OPTION B (journal/0095): rows carry an author-assigned, UNIQUE,
 *  STABLE **ID**. The close list references the ID. L4 reconciles on
 *  the exact ID set. There is NO prose name-parsing and NO
 *  normalization-collision residue — IDs are explicit tokens,
 *  uniqueness is mechanically enforced (L5), so the journal/0093
 *  documented lexical bound and the journal/0094 parser-regression
 *  class are STRUCTURALLY IMPOSSIBLE here, not merely mitigated.
 *
 *  Checks:
 *    L1  section present AND fence-balanced AND non-vacuous (≥1 row OR
 *        the line-anchored `Forest empty` sentinel).
 *    L2  every open row carries a non-empty value-anchor (column 3).
 *    L3  every "Closed this session" entry references a syntactic ID
 *        token AND cites a durable receipt SHAPE (PR #N | #N | 7-40-hex
 *        SHA w/ ≥1 digit | journal NNNN | journal/.pending/NNNN).
 *        SHAPE, not EXISTENCE — a fabricated-but-shaped receipt is a
 *        verify-resource-existence.md MUST-1 violation caught at
 *        gate-review, not here.
 *    L5  ledger IDs are UNIQUE within the section (a duplicate ID makes
 *        ID-conservation ambiguous — hard FLAG).
 *    contradiction  `Forest empty` asserted WITH open rows = FLAG.
 *
 *    L4 (only with --git-prior — the anti-vanish gate): every prior
 *        committed OPEN row ID is either still an open row ID in the
 *        current ledger OR appears as a referenced ID in the current
 *        "Closed this session" block. EXACT id-set match (trim only;
 *        IDs are verbatim-stable by contract). Zero residue: distinct
 *        workstreams have distinct IDs by L5, so no collision can mask
 *        a vanish. Without --git-prior the anti-vanish invariant is
 *        NOT mechanically enforced.
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**`). Zero client/org tokens;
 *  detection is purely structural (a STRUCTURAL probe per
 *  probe-driven-verification.md MUST-3).
 *
 *    --aggregate (issue #669 — the WORKSPACE→ROOT anti-vanish gate): every
 *        OPEN forest-ledger row in a `workspaces/<ws>/.session-notes` (or its
 *        M6-D split `.session-notes.shared.md`) MUST be reflected in the ROOT
 *        ledger (an open root row OR a root "Closed this session" reference).
 *        A workspace-open ID absent from root is a STRANDED item — the
 *        cross-file "vanish" that /sweep + /wrapup were blind to before #669.
 *        Complements --git-prior (intra-file, across commits) with the
 *        cross-file, workspace→root axis. ID-set membership only; no prose
 *        parsing.
 *
 *  Usage:
 *    node .claude/bin/validate-forest-ledger.mjs [--json] <.session-notes>
 *    node .claude/bin/validate-forest-ledger.mjs --git-prior <.session-notes>
 *    node .claude/bin/validate-forest-ledger.mjs --aggregate [--root <repo-root>]
 *
 *  Exit 0 = conformant. Exit 1 = ≥1 finding. Exit 2 = usage / IO error.
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const HEADING_RE = /^##[ \t]+Outstanding ledger \(forest\)\s*$/i;
// Whole-file shared-ledger anchor (`.session-notes.shared.md`): the `# Forest
// Ledger` heading authored by session-notes-layout.js::LEDGER_HEADER. Binding
// the shared-form parse to THIS section (not the whole file) is what keeps a
// non-ledger wide table elsewhere in the file from injecting spurious IDs.
const SHARED_HEADING_RE = /^#[ \t]+Forest Ledger\b/i;
const EMPTY_FOREST = /^\s*forest empty\b/im;
const FENCE_RE = /^\s*(```+|~~~+)/;

const RECEIPT_ALTS = [
  /(?:^|[\s([])#\d+\b/,
  /\bPR\s*#\d+\b/i,
  /(?:^|[\s([])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![0-9a-z])/i,
  /\bjournal[\s/](?:\.pending\/)?\.?\d{3,4}\b/i,
];
const hasReceipt = (s) => RECEIPT_ALTS.some((re) => re.test(s));

// ID normalization: trim + strip a surrounding markdown delimiter pair
// (backtick / asterisk). Applied IDENTICALLY at all three ID sites
// (prior rows, current rows, close tokens) so the canonical wrapup.md
// close form `<id>` reconciles with the bare `| <id> |` row form and
// vice-versa (journal/0097 HIGH-1 + MED-1 — symmetric, not one-sided).
// This is deterministic delimiter-stripping of a single bounded token,
// NOT prose parsing — it does not reopen the substring-mask class.
const normId = (s) =>
  String(s)
    .trim()
    .replace(/^[`*]+/, "")
    .replace(/[`*]+$/, "")
    .trim();

// Extract the referenced ID from a close entry: the FIRST whitespace /
// separator-delimited token after list chrome. Deterministic — an ID is
// a single token by contract, never free prose. "" if none (→ L3 flag).
function closeEntryId(entry) {
  const s = entry.replace(/^[\s>*-]+/, "");
  const tok = s.split(/[\s:]|→|->/)[0];
  return normId(tok || "");
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")) || c === "");
}
function isHeaderRow(cells) {
  const j = cells.join("|").toLowerCase();
  // Accept BOTH the inline `.session-notes` header (`Value-anchor`, hyphen)
  // AND the M6-D split `.session-notes.shared.md` header (`value_anchor`,
  // underscore — `.claude/hooks/lib/session-notes-layout.js::LEDGER_HEADER`).
  // Without the underscore form the shared ledger's literal `ID` header cell
  // would be parsed as a data-row id by the workspace→root aggregation.
  const hasAnchorCol = j.includes("value-anchor") || j.includes("value_anchor");
  return hasAnchorCol && (j.includes("item") || j.includes("id"));
}
// Verbatim wrapup.md template row: | <id> | <workstream> | <why ...> | BLOCKED on ... |
function isVerbatimTemplateRow(cells) {
  const n = cells.map((c) => c.trim().toLowerCase());
  return (
    n[0] === "<id>" &&
    n[1] === "<workstream>" &&
    n[2].startsWith("<why it matters") &&
    n[3] !== undefined &&
    n[3].startsWith("blocked on")
  );
}

function extractSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING_RE.test(l));
  if (start === -1) return null;
  const body = [];
  const rowLines = [];
  let fenceMarker = null;
  let fenceLen = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const fm = l.match(FENCE_RE);
    if (fm) {
      const run = fm[1];
      const kind = run[0];
      const len = run.length;
      if (fenceMarker === null) {
        fenceMarker = kind;
        fenceLen = len;
        body.push(l);
        continue;
      }
      if (kind === fenceMarker && len >= fenceLen) {
        fenceMarker = null;
        fenceLen = 0;
        body.push(l);
        continue;
      }
      body.push(l);
      continue;
    }
    if (fenceMarker === null && /^##\s/.test(l)) break;
    body.push(l);
    if (fenceMarker === null) rowLines.push(l);
  }
  return { body, rowLines, unterminated: fenceMarker !== null };
}

// Extract the whole-file shared-ledger section: the `# Forest Ledger` heading
// (SHARED_HEADING_RE) through the line before the next markdown heading. Binds
// the shared-form parse to its section so a non-ledger wide table elsewhere in
// the file is NOT parsed as ledger rows — the section-binding rigor the inline
// form already has via extractSection. Returns null if no shared ledger heading.
function extractSharedSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => SHARED_HEADING_RE.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}[ \t]/.test(lines[i])) break; // next heading ends the section
    out.push(lines[i]);
  }
  return out;
}

// Rows: | ID | Item | Value-anchor | Status |. Returns open rows with
// {id, item, anchor} + malformed (<4 col) + duplicate-id list (L5).
function parseRows(rowLines) {
  const rows = [];
  const malformed = [];
  const seen = new Map();
  const dupes = [];
  for (const raw of rowLines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (isSeparatorRow(cells) || isHeaderRow(cells)) continue;
    if (cells.length < 4) {
      malformed.push(line);
      continue;
    }
    if (isVerbatimTemplateRow(cells)) continue;
    const id = normId(cells[0]);
    if (id === "") {
      malformed.push(line);
      continue;
    }
    if (seen.has(id)) dupes.push(id);
    else seen.set(id, true);
    rows.push({ id, item: cells[1], anchor: cells[2] });
  }
  return { rows, malformed, dupes };
}

// Close-entry collector (block parser — converged at journal/0094 R5).
// An ENTRY is the non-empty inline tail OR a `-`/`*` bullet (+ soft-wrap
// continuations). Non-bullet prose with no entry in progress is SKIPPED
// (continue, not break — journal/0094) so receiptless bullets after a
// summary sentence are still collected. Blank ends the block unless the
// next non-blank is a bullet.
function closeEntries(body) {
  const entries = [];
  for (let i = 0; i < body.length; i++) {
    const m = body[i].trim().match(/closed this session\s*:?(.*)$/i);
    if (!m) continue;
    let cur = m[1].trim() ? m[1].trim() : null;
    for (let j = i + 1; j < body.length; j++) {
      const b = body[j].trim();
      if (b.startsWith("|") || /^##\s/.test(b)) break;
      if (b === "") {
        let k = j + 1;
        while (k < body.length && body[k].trim() === "") k++;
        const nxt = k < body.length ? body[k].trim() : "";
        if (/^[-*]\s+/.test(nxt)) {
          j = k - 1;
          continue;
        }
        break;
      }
      if (/^[-*]\s+/.test(b)) {
        if (cur !== null) entries.push(cur);
        cur = b.replace(/^[-*]\s+/, "");
      } else if (cur === null) {
        continue; // narrative prose, no entry yet — skip, do not end block
      } else {
        cur = `${cur} ${b}`; // soft-wrap continuation
      }
    }
    if (cur !== null) entries.push(cur);
    break;
  }
  return entries;
}

function priorOpen(notesPath) {
  // Prior COMMITTED .session-notes via `git show HEAD:<path>`. argv-form
  // execFileSync — no shell. The leading `HEAD:` is the option-injection
  // guard: git parses the token as <rev>:<path>, never an option flag.
  // DO NOT pass `notesPath` as a bare argv element. Bounded; a buffer/timeout
  // error is a HARD "L4 inconclusive" finding, never a silent skip.
  let prior;
  try {
    prior = execFileSync("git", ["show", `HEAD:${notesPath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    const code = (e && (e.code || e.errno)) || "";
    const msg = (e && e.message) || "";
    if (
      code === "ENOBUFS" ||
      code === "ETIMEDOUT" ||
      (e && e.signal === "SIGTERM") ||
      /maxBuffer/i.test(msg)
    ) {
      return { error: `git show failed (${code || e.signal || "maxBuffer"}) — L4 inconclusive` };
    }
    return null;
  }
  const sec = extractSection(prior);
  if (sec === null) return { ids: [], dupes: [] };
  const p = parseRows(sec.rowLines);
  return { ids: p.rows.map((r) => r.id), dupes: [...new Set(p.dupes)] };
}

function validate(notesPath, { gitPrior } = {}) {
  let text;
  try {
    text = readFileSync(notesPath, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read ${notesPath}: ${e.message}` };
  }

  const findings = [];
  const sec = extractSection(text);
  if (sec === null) {
    findings.push({
      rule: "L1",
      msg: `missing "## Outstanding ledger (forest)" section — absent ledger is the stale-snapshot trap (journal/0089)`,
    });
    return { ok: false, findings };
  }

  const { body, rowLines, unterminated } = sec;
  if (unterminated) {
    findings.push({
      rule: "L1",
      msg: `unterminated code fence in ledger section — rows after it are invisible; balance the fence (journal/0092)`,
    });
  }

  const emptyForest = EMPTY_FOREST.test(rowLines.join("\n"));
  const { rows, malformed, dupes } = parseRows(rowLines);

  if (!unterminated && !emptyForest && rows.length === 0 && malformed.length === 0) {
    findings.push({
      rule: "L1",
      msg: `ledger section present but contains no rows and no "Forest empty" sentinel — indistinguishable from a dropped ledger (journal/0089)`,
    });
  }
  for (const bad of malformed) {
    findings.push({
      rule: "L2",
      msg: `malformed ledger row (expected | ID | Item | Value-anchor | Status |): ${bad}`,
    });
  }
  for (const d of [...new Set(dupes)]) {
    findings.push({
      rule: "L5",
      msg: `duplicate ledger ID "${d}" — IDs MUST be unique (ID-conservation is ambiguous otherwise; journal/0095)`,
    });
  }
  if (emptyForest && rows.length > 0) {
    findings.push({
      rule: "L2",
      msg: `"Forest empty" asserted but ${rows.length} open row(s) present — contradictory ledger state`,
    });
  }
  if (!(emptyForest && rows.length === 0)) {
    for (const r of rows) {
      if (r.anchor === "" || /^-+$/.test(r.anchor)) {
        findings.push({
          rule: "L2",
          msg: `ledger row "${r.id}" has no value-anchor (value-prioritization.md MUST-1+2)`,
        });
      }
    }
  }

  const entries = closeEntries(body);
  for (const e of entries) {
    const id = closeEntryId(e);
    if (id === "") {
      findings.push({
        rule: "L3",
        msg: `"Closed this session" entry references no ID token — cannot reconcile: ${e}`,
      });
    }
    if (!hasReceipt(e)) {
      findings.push({
        rule: "L3",
        msg: `"Closed this session" entry cites no durable receipt (PR#/#N/SHA/journal NNNN) — not closed: ${e}`,
      });
    }
  }

  if (gitPrior) {
    const prior = priorOpen(notesPath);
    if (prior === null) {
      findings.push({
        rule: "L4",
        severity: "note",
        msg: `no prior committed .session-notes (first commit / not in git) — anti-vanish check skipped (not a failure)`,
      });
    } else if (prior.error) {
      findings.push({ rule: "L4", msg: prior.error });
    } else {
      // prior ledger was non-L5-clean (duplicate IDs) — conservation is
      // ambiguous; surface it rather than trust silently (journal/0097
      // cc-arch MED). Per-occurrence iteration below still fails LOUD
      // (each prior occurrence must be individually satisfied), so this
      // is a transparency finding, not a masked-vanish.
      for (const d of prior.dupes || []) {
        findings.push({
          rule: "L4",
          msg: `prior committed ledger had duplicate ID "${d}" — it was not L5-clean; ID-conservation against it is ambiguous`,
        });
      }
      const currentIds = new Set(rows.map((r) => r.id));
      const closedIds = new Set(
        entries.map(closeEntryId).filter((x) => x !== ""),
      );
      for (const id of prior.ids) {
        if (!currentIds.has(id) && !closedIds.has(id)) {
          findings.push({
            rule: "L4",
            msg: `prior open ID "${id}" vanished — not carried forward and not referenced in "Closed this session" (wrapup.md reconciliation step 2)`,
          });
        }
      }
    }
  }

  const hard = findings.filter((f) => f.severity !== "note");
  return { ok: hard.length === 0, findings };
}

// ============================================================================
//  Workspace→root aggregation (--aggregate) — the CROSS-FILE anti-vanish gate
//  (issue #669). The intra-file --git-prior gate above conserves IDs WITHIN one
//  .session-notes across commits; this gate conserves them ACROSS the
//  workspace→root boundary: every OPEN forest-ledger row in a
//  workspaces/*/.session-notes (or its M6-D split .session-notes.shared.md)
//  MUST be reflected in the ROOT ledger (open row OR "Closed this session"
//  reference). A workspace-open ID absent from root is a STRANDED item — the
//  exact "vanish" /sweep + /wrapup were blind to before #669. Detection is
//  purely structural (ID-set membership); no client/org tokens (synced artifact).
// ============================================================================

// Resolve the forest-ledger file for a directory: the M6-D split
// `.session-notes.shared.md` takes precedence (knowledge-convergence.md MUST-1),
// else the legacy inline `.session-notes`. null if neither exists.
function resolveLedgerPath(dir) {
  const shared = path.join(dir, ".session-notes.shared.md");
  if (existsSync(shared)) return shared;
  const inline = path.join(dir, ".session-notes");
  if (existsSync(inline)) return inline;
  return null;
}

// Collect OPEN row IDs + closed-this-session IDs from a ledger file, handling
// BOTH shapes: the inline `## Outstanding ledger (forest)` section AND the
// whole-file `# Forest Ledger` shared-ledger form. Returns null on read error.
// "Open" = a table-row ID NOT referenced in a "Closed this session" entry.
function collectLedgerIds(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let rowLines;
  let body;
  const sec = extractSection(text);
  if (sec) {
    // Inline `## Outstanding ledger (forest)` form — bound to the section so
    // unrelated tables elsewhere in the file are not parsed as ledger rows.
    rowLines = sec.rowLines;
    body = sec.body;
  } else {
    // Whole-file shared-ledger form (`.session-notes.shared.md`): bind the
    // parse to the `# Forest Ledger` SECTION (heading → next heading), NOT the
    // whole file — a non-ledger wide table elsewhere in the file must not
    // inject spurious IDs (matches the inline form's section-binding rigor).
    // No "Closed this session" concept here (closed rows are merged out), so
    // closedIds is empty.
    const sharedRows = extractSharedSection(text);
    if (sharedRows === null) {
      // No forest ledger present in this file — nothing to conserve.
      return { openIds: [], closedIds: [] };
    }
    rowLines = sharedRows;
    body = sharedRows;
  }
  const { rows } = parseRows(rowLines);
  const closedIds = new Set(
    closeEntries(body)
      .map(closeEntryId)
      .filter((x) => x !== ""),
  );
  const openIds = [
    ...new Set(rows.map((r) => r.id).filter((id) => !closedIds.has(id))),
  ];
  return { openIds, closedIds: [...closedIds] };
}

// List workspace dirs under <root>/workspaces, skipping `instructions` + any
// leading-underscore meta-dir (cc-artifacts.md Rule 8). Sorted for determinism.
function listWorkspaces(rootDir) {
  const wsRoot = path.join(rootDir, "workspaces");
  try {
    return readdirSync(wsRoot, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name !== "instructions" &&
          !e.name.startsWith("_"),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function aggregate(rootDir) {
  const findings = [];

  // Root ledger known-ID set = its open rows ∪ its closed-this-session refs.
  // A workspace-open ID present in EITHER is "reflected at root" (not stranded).
  const rootLedger = resolveLedgerPath(rootDir);
  const rootKnown = new Set();
  let rootAbsent = false;
  if (rootLedger) {
    const r = collectLedgerIds(rootLedger);
    if (r) {
      for (const id of r.openIds) rootKnown.add(id);
      for (const id of r.closedIds) rootKnown.add(id);
    }
  } else {
    rootAbsent = true;
  }

  // Collect every (workspace, open-id) pair; flag those absent from root.
  const stranded = [];
  let workspacesWithLedger = 0;
  for (const ws of listWorkspaces(rootDir)) {
    const led = resolveLedgerPath(path.join(rootDir, "workspaces", ws));
    if (!led) continue;
    const r = collectLedgerIds(led);
    if (!r) continue;
    workspacesWithLedger++;
    const rel = path.relative(rootDir, led);
    for (const id of r.openIds) {
      if (!rootKnown.has(id)) stranded.push({ id, ws, rel });
    }
  }
  // Deterministic ordering: by workspace path, then by ID.
  stranded.sort((a, b) => a.rel.localeCompare(b.rel) || a.id.localeCompare(b.id));

  if (rootAbsent && stranded.length > 0) {
    findings.push({
      rule: "AGG",
      msg: `no root ledger (.session-notes / .session-notes.shared.md) at ${rootDir} — ${stranded.length} open workspace ID(s) cannot be reconciled upward (wrapup.md rollup never ran)`,
    });
  }
  for (const s of stranded) {
    findings.push({
      rule: "AGG",
      msg: `open workspace-ledger ID "${s.id}" (${s.rel}) absent from root ledger — workspace→root no-vanish (issue #669)`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    rootLedger: rootLedger ? path.relative(rootDir, rootLedger) : null,
    workspacesScanned: workspacesWithLedger,
    strandedCount: stranded.length,
  };
}

// ---- CLI ----
const args = process.argv.slice(2);
const json = args.includes("--json");
const gitPrior = args.includes("--git-prior");
const doAggregate = args.includes("--aggregate");
// `--root <dir>` takes the next token; everything else non-`--` is the
// positional .session-notes path (intra-file modes).
let rootDir = null;
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--root") {
    rootDir = args[++i];
    continue;
  }
  if (a.startsWith("--")) continue;
  positionals.push(a);
}
const notesPath = positionals[0];

if (doAggregate) {
  // Workspace→root aggregation (issue #669). Default root = cwd.
  const root = rootDir || process.cwd();
  const result = aggregate(root);
  if (json) {
    console.log(JSON.stringify({ mode: "aggregate", root, ...result }, null, 2));
  } else if (result.ok) {
    console.log(
      `OK forest-ledger aggregation: ${result.workspacesScanned} workspace ledger(s); all open IDs reflected in root (${result.rootLedger || "no root ledger, but nothing to reconcile"})`,
    );
  } else {
    console.log(`FAIL forest-ledger aggregation: ${root}`);
    for (const f of result.findings) console.log(`  [${f.rule}] ${f.msg}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (!notesPath) {
  console.error(
    "usage: validate-forest-ledger.mjs [--json] [--git-prior] <.session-notes>\n" +
      "       validate-forest-ledger.mjs --aggregate [--json] [--root <repo-root>]",
  );
  process.exit(2);
}

const result = validate(notesPath, { gitPrior });

if (result.error) {
  console.error(result.error);
  process.exit(2);
}

if (json) {
  console.log(JSON.stringify({ file: notesPath, ...result }, null, 2));
} else if (result.ok) {
  console.log(`OK forest-ledger conformant: ${notesPath}`);
  for (const f of result.findings || [])
    console.log(`  [${f.rule}] note: ${f.msg}`);
} else {
  console.log(`FAIL forest-ledger: ${notesPath}`);
  for (const f of result.findings)
    console.log(`  [${f.rule}]${f.severity === "note" ? " note:" : ""} ${f.msg}`);
}

process.exit(result.ok ? 0 : 1);
