"use strict";
/**
 * tenant-upsert — decide whether source text builds an upsert-conflict statement
 * that `tenant-isolation.md` Rule 7 requires to be TENANT-GUARDED, and whether
 * the guard is present.
 *
 * WHY THIS EXISTS. Rule 7's Detection mechanism was Phase 1 (manual) only: a
 * reviewer enumerates every `ON CONFLICT`/`ON DUPLICATE KEY` `DO UPDATE` builder
 * and greps each for the tenant predicate. The registry row
 * (`phase2-deferrals.json::tenant-isolation.md#rule-7-upsert`) states the defect
 * of that arrangement exactly: "A missed builder is a cross-tenant write, and the
 * enumeration is only as complete as the reviewer who ran it that day." This
 * module is that enumeration, run on every durable write instead of on the days
 * somebody remembers.
 *
 * ── THE ENUMERATED SET COMES FROM THE RULE, NOT FROM RECALL
 *
 * Rule 7's own body (`rules/tenant-isolation.md` § 7, and its Audit Protocol grep
 * `rg -l 'DO UPDATE SET|ON DUPLICATE KEY UPDATE'`) names exactly TWO emitted
 * forms:
 *
 *   INSERT ... ON CONFLICT (<target>) DO UPDATE SET ...    (PostgreSQL / SQLite)
 *   INSERT ... ON DUPLICATE KEY UPDATE ...                 (MySQL)
 *
 * and exactly TWO guards:
 *
 *   (b) PG/SQLite:  ... DO UPDATE SET ... WHERE {table}.tenant_id = EXCLUDED.tenant_id
 *   (b) MySQL:      <col> = IF(tenant_id = VALUES(tenant_id), VALUES(<col>), <col>)
 *   (a) BOTH:       tenant_id is EXCLUDED from the SET clause
 *
 * `MERGE ... WHEN MATCHED` and `INSERT OR REPLACE` are NOT in Rule 7's enumerated
 * set and are therefore NOT scanned. That silence is SCOPE, never coverage: if
 * Rule 7 is ever widened to them, this module must be widened in the same change.
 *
 * ── THE TWO HALVES ARE CHECKED BY DIFFERENT TESTS, DELIBERATELY
 *
 * The guard token and the violation token are LEXICALLY IDENTICAL. In the WHERE
 * clause `tenant_id = EXCLUDED.tenant_id` IS the guard (b); in the SET clause the
 * same eleven characters ARE the ownership flip (a) forbids. A single
 * co-presence grep — which is what the Phase-1 protocol is — therefore reads a
 * half-(a) VIOLATION as satisfying half (b). So:
 *
 *   half (b) is decided by presence of the guard token ANYWHERE in the file
 *            (fragment builders put the WHERE in a separate variable, so
 *             file scope is the only scope that can see it);
 *   half (a) is decided ONLY inside a VISIBLE set body, by splitting the
 *            assignment list at depth-0 commas and reading each LHS.
 *
 * Because they are independent, a `tenant_id = EXCLUDED.tenant_id` sitting in the
 * SET cannot silence half (a) by satisfying half (b).
 *
 * ── DECLARED BLIND CLASSES (this module is SILENT on all of them; silence here
 *    is NOT evidence of compliance — `instrument-discipline.md` MUST-3)
 *
 *   B1 NON-LITERAL BUILDERS. An upsert assembled through an ORM/query-builder API
 *      (`.on_conflict_do_update(...)`, `.upsert(...)`) never spells `ON CONFLICT`
 *      in source text. Unreachable by any single-statement matcher.
 *   B2 CONCATENATED / MULTI-VARIABLE SQL whose `ON CONFLICT` and `DO UPDATE`
 *      land more than GAP_MAX characters apart, or in different variables
 *      entirely. The matcher follows one bounded window, not dataflow.
 *   B3 `ON CONFLICT ON CONSTRAINT <name>` — the tenant discriminator may live in
 *      the UNIQUE INDEX the statement names, which is not in this file and may
 *      not be in this repo. Firing would be a false positive on correct code, so
 *      this form is passed over.
 *   B4 half (a) when the SET body is a PLACEHOLDER (`{', '.join(set_parts)}`).
 *      The column list is computed at run time; nothing lexical can read it.
 *   B5 A genuinely multi-tenant upsert in a file that never says "tenant" —
 *      tenancy injected by a base class or a mixin. `isTenantAware` is a scoping
 *      fence that buys quiet on single-tenant code at exactly this cost.
 *   B6 Writes that do not go through Edit/Write/NotebookEdit (a Bash heredoc or
 *      `>` redirect). That gap belongs to the Bash surface, not to this predicate.
 *
 * Each blind class is pinned by a KNOWN-MISS case in
 * `.claude/audit-fixtures/tenant-upsert-guard/run.mjs`, so a later reader cannot
 * mistake the silence for coverage.
 *
 * ── OUTPUT DISCIPLINE
 *
 * The signal is LEXICAL over source text, so `hook-output-discipline.md` MUST-2
 * bars `block`. Rule 7's own Trust-Posture Wiring already declares `advisory` at
 * the hook layer ("the tenant-guard property is judgment-bearing over generated
 * SQL"); consumers MUST NOT emit stronger than that rule's declared severity.
 */

/** Max characters between `ON CONFLICT` and its `DO UPDATE` / `DO NOTHING`. */
const GAP_MAX = 400;
/** Max characters of set-body / where-body examined after a keyword. */
const BODY_MAX = 600;

/** Vocabulary that makes a file a plausible `multi_tenant=True` surface (fence B5). */
const TENANT_VOCAB =
  /\b(?:multi_tenant|tenant_id|get_current_tenant_id|TenantRequiredError|tenant_guarded|tenant_scoped)\b/;

/** Source extensions worth scanning. A `.md` rule/doc is excluded by design: this
 *  module's own DO-NOT examples live in `rules/tenant-isolation.md`. */
const SOURCE_EXT =
  /\.(?:py|pyi|rs|js|mjs|cjs|ts|tsx|go|java|kt|kts|rb|cs|php|scala|ex|exs|sql|tmpl|j2)$/i;

/** Paths whose whole purpose is to CONTAIN the violating shape as an example. */
const SELF_REFERENTIAL =
  /(?:^|\/)(?:\.claude\/(?:rules|audit-fixtures|skills|guides|test-harness)|guides\/rule-extracts)\//;

/**
 * Is this path a surface this predicate should read at all?
 * Fail CLOSED to "not in scope" — an unscannable path yields silence, never a guess.
 */
function isScannablePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  const p = relPath.replace(/\\/g, "/");
  if (p.startsWith("..")) return false;
  if (SELF_REFERENTIAL.test(`/${p}`)) return false;
  return SOURCE_EXT.test(p);
}

/** Does the file carry multi-tenant vocabulary at all? (fence B5) */
function isTenantAware(text) {
  return typeof text === "string" && TENANT_VOCAB.test(text);
}

/** A span that looks computed at run time rather than written out. */
function isPlaceholder(s) {
  return /\$?\{|%\(|%s|\$\d|\?\s*[,)]|<%|\{\{/.test(s);
}

/**
 * Split a SQL assignment list at depth-0 commas. Parens are tracked so
 * `IF(tenant_id = VALUES(tenant_id), VALUES(v), v)` stays ONE item rather than
 * three — which is the whole reason half (a) cannot be done with a comma split
 * on the raw string.
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Does this assignment list assign to `tenant_id` at top level?
 * `tenant_id = IF(...)` / `tenant_id = EXCLUDED.tenant_id` / `tenant_id = VALUES(tenant_id)`
 * are all the half-(a) violation: tenant_id belongs OUT of the SET.
 */
function setBodyAssignsTenant(body) {
  for (const item of splitTopLevel(body)) {
    const m = /^\s*(?:[`"[]?\w+[`"\]]?\s*\.\s*)?[`"[]?(\w+)[`"\]]?\s*=(?!=)/.exec(item);
    if (m && m[1].toLowerCase() === "tenant_id") return item.trim().slice(0, 120);
  }
  return null;
}

/**
 * The half-(b) guard, present ANYWHERE in the file.
 *  - PG/SQLite: `WHERE <t>.tenant_id = EXCLUDED.tenant_id` (the WHERE may be in a
 *    separate f-string variable, so the WHERE itself is not required to be adjacent)
 *  - MySQL:     `IF(tenant_id = ...)` per the rule's own grep `IF(tenant_id =`
 */
function findTenantGuard(text) {
  const where = /WHERE[\s\S]{0,200}?(?:\w+\s*\.\s*)?tenant_id\s*=\s*EXCLUDED\s*\.\s*tenant_id/i.exec(text);
  if (where) return { kind: "where-excluded", excerpt: squeeze(where[0]) };
  const mysql = /\bIF\s*\(\s*(?:\w+\s*\.\s*)?tenant_id\s*=/i.exec(text);
  if (mysql) return { kind: "mysql-if", excerpt: squeeze(mysql[0]) };
  const bare = /(?:\w+\s*\.\s*)?tenant_id\s*=\s*EXCLUDED\s*\.\s*tenant_id/i.exec(text);
  if (bare) return { kind: "bare-excluded", excerpt: squeeze(bare[0]) };
  return null;
}

/**
 * Does the file declare a conflict key that already carries the tenant? A
 * composite conflict target means a cross-tenant `id` collision is not a conflict
 * at all, so Rule 7's `WHERE` guard is not owed — firing here would be a FALSE
 * POSITIVE on correct code, which is the failure the brief names.
 */
function declaresTenantConflictKey(text) {
  return /conflict(?:_on|_target|_cols|_columns|_keys)?\s*[=:]\s*[[(][^\])]{0,200}tenant_id/i.test(text);
}

function squeeze(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Enumerate every upsert-conflict construction in `text`.
 * @returns {Array<{dialect:string, index:number, line:number, target:string|null,
 *                  setBody:string|null, excerpt:string, blind:string|null}>}
 */
function enumerateUpsertBuilders(text) {
  const found = [];
  if (typeof text !== "string" || text.length === 0) return found;

  // ── PG / SQLite: ON CONFLICT [target] DO UPDATE SET ...
  const onConflict = /\bON\s+CONFLICT\b/gi;
  let m;
  while ((m = onConflict.exec(text)) !== null) {
    const window = text.slice(m.index, m.index + GAP_MAX);
    const doClause = /\bDO\s+(UPDATE|NOTHING)\b/i.exec(window);
    if (!doClause) continue; // B2 — the DO clause is out of window or in another variable
    if (doClause[1].toUpperCase() === "NOTHING") continue; // no overwrite; Rule 7 does not reach it

    const head = window.slice(0, doClause.index);
    if (/\bON\s+CONSTRAINT\b/i.test(head)) {
      found.push({
        dialect: "postgres",
        index: m.index,
        line: lineOf(text, m.index),
        target: null,
        setBody: null,
        excerpt: squeeze(window.slice(0, doClause.index + 20)),
        blind: "B3", // constraint-named target — tenant scoping may live in the index
      });
      continue;
    }

    const paren = /\(([^)]{0,200})\)/.exec(head);
    const target = paren ? paren[1] : null;

    const after = window.slice(doClause.index);
    const setKw = /\bSET\b/i.exec(after);
    let setBody = null;
    if (setKw) {
      const raw = after.slice(setKw.index + setKw[0].length, setKw.index + setKw[0].length + BODY_MAX);
      // Stop the set body at WHERE (that is half (b)'s territory) or at the
      // end of the string literal / statement.
      const stop = /\bWHERE\b|["'`]|;/.exec(raw);
      setBody = stop ? raw.slice(0, stop.index) : raw;
    }
    found.push({
      dialect: "postgres",
      index: m.index,
      line: lineOf(text, m.index),
      target,
      setBody,
      excerpt: squeeze(window.slice(0, doClause.index + 20)),
      blind: null,
    });
  }

  // ── MySQL: ON DUPLICATE KEY UPDATE ...
  const odku = /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi;
  while ((m = odku.exec(text)) !== null) {
    const raw = text.slice(m.index + m[0].length, m.index + m[0].length + BODY_MAX);
    const stop = /["'`]|;/.exec(raw);
    found.push({
      dialect: "mysql",
      index: m.index,
      line: lineOf(text, m.index),
      target: null,
      setBody: stop ? raw.slice(0, stop.index) : raw,
      excerpt: squeeze(m[0]),
      blind: null,
    });
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * Audit `text` (already known to be a scannable, tenant-aware source file).
 *
 * FALSIFYING RESULT, named per `instrument-discipline.md` MUST-1: on the
 * COMPLIANT pole — the same statement carrying `WHERE {t}.tenant_id =
 * EXCLUDED.tenant_id` and no `tenant_id` in the SET — `findings` is EMPTY and
 * `ran` is true. If the compliant pole ever produces a finding, the predicate
 * does not discriminate and MUST NOT be shipped.
 *
 * @returns {{ran:boolean, reason:string|null, builders:number, blind:Array,
 *            findings:Array<{half:string, dialect:string, line:number,
 *                            excerpt:string, detail:string}>}}
 */
function auditUpserts(text) {
  const empty = { ran: false, reason: null, builders: 0, blind: [], findings: [] };
  if (typeof text !== "string" || text.length === 0) {
    return { ...empty, reason: "empty-content" };
  }
  const builders = enumerateUpsertBuilders(text);
  if (builders.length === 0) return { ...empty, ran: true, reason: "no-upsert-builder" };
  if (!isTenantAware(text)) {
    // B5 — out of Rule 7's declared scope (`multi_tenant=True` models only).
    return {
      ran: true,
      reason: "not-tenant-aware",
      builders: builders.length,
      blind: [{ klass: "B5", line: builders[0].line }],
      findings: [],
    };
  }

  const guard = findTenantGuard(text);
  const tenantConflictKey = declaresTenantConflictKey(text);
  const findings = [];
  const blind = [];

  for (const b of builders) {
    if (b.blind) {
      blind.push({ klass: b.blind, line: b.line, excerpt: b.excerpt });
      continue;
    }

    // ── half (a): tenant_id inside the SET clause is an ownership flip.
    if (b.setBody === null) {
      blind.push({ klass: "B4", line: b.line, excerpt: b.excerpt });
    } else if (isPlaceholder(b.setBody)) {
      blind.push({ klass: "B4", line: b.line, excerpt: b.excerpt });
    } else {
      const assigned = setBodyAssignsTenant(b.setBody);
      // For MySQL the guard IS an assignment — `tenant_id` must still not be one
      // of the assigned columns, but `<col> = IF(tenant_id = ...)` is fine and is
      // held together by splitTopLevel's paren tracking.
      if (assigned) {
        findings.push({
          half: "a",
          dialect: b.dialect,
          line: b.line,
          excerpt: b.excerpt,
          detail: `tenant_id is assigned inside the ${b.dialect === "mysql" ? "ON DUPLICATE KEY UPDATE" : "DO UPDATE SET"} clause: \`${assigned}\` — Rule 7(a) requires tenant_id be EXCLUDED from the SET (an ON CONFLICT resolution that writes tenant_id flips the row's ownership).`,
        });
      }
    }

    // ── half (b): the conflict resolution must be gated by the row's own tenant.
    const targetCarriesTenant = b.target !== null && /\btenant_id\b/i.test(b.target);
    if (targetCarriesTenant || tenantConflictKey) continue; // composite key ⇒ no cross-tenant conflict
    if (guard) continue;

    findings.push({
      half: "b",
      dialect: b.dialect,
      line: b.line,
      excerpt: b.excerpt,
      detail:
        b.dialect === "mysql"
          ? "ON DUPLICATE KEY UPDATE with no `IF(tenant_id = VALUES(tenant_id), <new>, <col>)` guard anywhere in the file, and no tenant column in the conflict key — Rule 7(b). A cross-tenant id collision resolves by OVERWRITING the other tenant's row, returning success."
          : "ON CONFLICT ... DO UPDATE with no `WHERE <table>.tenant_id = EXCLUDED.tenant_id` guard anywhere in the file, and no tenant column in the conflict target — Rule 7(b). A cross-tenant id collision resolves by OVERWRITING the other tenant's row, returning success.",
    });
  }

  return { ran: true, reason: null, builders: builders.length, blind, findings };
}

const BLIND_LABELS = {
  B1: "ORM / query-builder upserts (`.on_conflict_do_update`) — never spelled in source text",
  B2: "`ON CONFLICT` and `DO UPDATE` split across variables or >400 chars apart",
  B3: "`ON CONFLICT ON CONSTRAINT <name>` — tenant scoping may live in the named index",
  B4: "a computed SET body (`{', '.join(set_parts)}`) — half (a) is unreadable",
  B5: "a file with no multi-tenant vocabulary — out of Rule 7's declared scope",
  B6: "writes that bypass Edit/Write/NotebookEdit (Bash heredoc / redirect)",
};

/** Render the advisory body. Returns null when there is nothing to say. */
function renderUpsertFindings(result, relPath) {
  if (!result || !result.ran || !result.findings || result.findings.length === 0) return null;
  const lines = [
    `\`tenant-isolation.md\` Rule 7 — ${result.findings.length} un-guarded upsert-conflict ` +
      `construction(s) in \`${relPath}\` (${result.builders} builder(s) enumerated).`,
    "",
  ];
  for (const f of result.findings) {
    lines.push(`- line ${f.line} [half ${f.half}, ${f.dialect}] \`${f.excerpt}\``);
    lines.push(`  ${f.detail}`);
  }
  lines.push("");
  lines.push(
    "This is a LEXICAL scan and it is INCOMPLETE by construction. It cannot see: " +
      Object.values(BLIND_LABELS).join("; ") +
      ". Its silence on any of those is NOT evidence of compliance — run the Rule 7 Audit Protocol grep over every builder.",
  );
  return lines.join("\n");
}

module.exports = {
  isScannablePath,
  isTenantAware,
  enumerateUpsertBuilders,
  setBodyAssignsTenant,
  splitTopLevel,
  findTenantGuard,
  declaresTenantConflictKey,
  auditUpserts,
  renderUpsertFindings,
  BLIND_LABELS,
  GAP_MAX,
};
