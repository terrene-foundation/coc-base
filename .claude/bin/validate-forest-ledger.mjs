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
 *  Usage:
 *    node .claude/bin/validate-forest-ledger.mjs [--json] <.session-notes>
 *    node .claude/bin/validate-forest-ledger.mjs --git-prior <.session-notes>
 *
 *  Exit 0 = conformant. Exit 1 = ≥1 finding. Exit 2 = usage / IO error.
 * ============================================================================
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HEADING_RE = /^##[ \t]+Outstanding ledger \(forest\)\s*$/i;
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
  return j.includes("value-anchor") && (j.includes("item") || j.includes("id"));
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

function priorOpen(path) {
  // Prior COMMITTED .session-notes via `git show HEAD:<path>`. argv-form
  // execFileSync — no shell. The leading `HEAD:` is the option-injection
  // guard: git parses the token as <rev>:<path>, never an option flag.
  // DO NOT pass `path` as a bare argv element. Bounded; a buffer/timeout
  // error is a HARD "L4 inconclusive" finding, never a silent skip.
  let prior;
  try {
    prior = execFileSync("git", ["show", `HEAD:${path}`], {
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

function validate(path, { gitPrior } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${e.message}` };
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
    const prior = priorOpen(path);
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

// ---- CLI ----
const args = process.argv.slice(2);
const json = args.includes("--json");
const gitPrior = args.includes("--git-prior");
const path = args.find((a) => !a.startsWith("--"));

if (!path) {
  console.error("usage: validate-forest-ledger.mjs [--json] [--git-prior] <.session-notes>");
  process.exit(2);
}

const result = validate(path, { gitPrior });

if (result.error) {
  console.error(result.error);
  process.exit(2);
}

if (json) {
  console.log(JSON.stringify({ file: path, ...result }, null, 2));
} else if (result.ok) {
  console.log(`OK forest-ledger conformant: ${path}`);
  for (const f of result.findings || [])
    console.log(`  [${f.rule}] note: ${f.msg}`);
} else {
  console.log(`FAIL forest-ledger: ${path}`);
  for (const f of result.findings)
    console.log(`  [${f.rule}]${f.severity === "note" ? " note:" : ""} ${f.msg}`);
}

process.exit(result.ok ? 0 : 1);
