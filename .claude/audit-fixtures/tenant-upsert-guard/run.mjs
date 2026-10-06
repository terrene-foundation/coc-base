#!/usr/bin/env node
/**
 * tenant-upsert-guard — fixtures for the Phase-2 detector of
 * `tenant-isolation.md` Rule 7 (`hooks/tenant-upsert-guard.js`) and its
 * predicate (`hooks/lib/tenant-upsert.js`).
 *
 * BIPOLAR PER BUILDER FORM, which is the whole point. Rule 7 names exactly two
 * emitted forms, and each gets a pole that MUST fire and a pole that MUST stay
 * silent — the SAME statement, differing only by the tenant predicate:
 *
 *   ON CONFLICT ... DO UPDATE  (PG/SQLite)  violation | compliant
 *   ON DUPLICATE KEY UPDATE    (MySQL)      violation | compliant
 *   half (a) tenant_id in SET               violation | compliant
 *
 * The compliant poles are NOT decoration. A detector shown only to FIRE proves it
 * can say "no"; the silent poles are the ONLY evidence it is not a nuisance —
 * and on a SECURITY rule a nuisance detector is strictly worse than the honest
 * deferral it replaced, because it trains reviewers to skip the finding.
 *
 * FALSE-POSITIVE POLES are carried separately and are the load-bearing ones: a
 * COMPOSITE conflict key, a `conflict_on` variable that carries the tenant, and
 * `DO NOTHING` are all CORRECT code that a naive "ON CONFLICT without
 * tenant_id = EXCLUDED.tenant_id" grep would flag.
 *
 * KNOWN MISSES (B1–B6) are pinned as EXPLICIT cases asserting SILENCE, so a later
 * reader cannot mistake the silence for coverage (`instrument-discipline.md`
 * MUST-3). Each is named in the module header and repeated in every advisory the
 * hook emits.
 *
 * The hook is invoked as a REAL subprocess over a REAL stdin payload against REAL
 * temporary files. Nothing is mocked, so a case cannot pass against a hook the
 * harness would not actually run.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const GUARD = path.join(HOOKS, "tenant-upsert-guard.js");
const lib = require(path.join(HOOKS, "lib", "tenant-upsert.js"));

let pass = 0;
const failures = [];
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

// ── the corpus ───────────────────────────────────────────────────────────────
// Every pair below is the SAME statement twice. The only difference between the
// poles is the tenant predicate Rule 7 requires.

const PG_COMPLIANT = `
# multi_tenant=True model; global single-column id PK
def build_upsert(table, cols, tenant_guarded):
    update_cols = [c for c in cols if c != "id" and not (tenant_guarded and c == "tenant_id")]
    set_parts = [f"{c} = EXCLUDED.{c}" for c in update_cols]
    where = f" WHERE {table}.tenant_id = EXCLUDED.tenant_id" if tenant_guarded else ""
    return f"INSERT INTO {table} VALUES (...) ON CONFLICT (id) DO UPDATE SET {', '.join(set_parts)}{where}"
`;

const PG_VIOLATION = `
# multi_tenant=True model; global single-column id PK
def build_upsert(table, cols, tenant_guarded):
    set_parts = [f"{c} = EXCLUDED.{c}" for c in cols if c != "id"]
    return f"INSERT INTO {table} VALUES (...) ON CONFLICT (id) DO UPDATE SET {', '.join(set_parts)}"
`;

const PG_LITERAL_COMPLIANT = `
MULTI_TENANT = True
SQL = """INSERT INTO orders (id, tenant_id, total) VALUES (%s, %s, %s)
ON CONFLICT (id) DO UPDATE SET total = EXCLUDED.total, updated_at = EXCLUDED.updated_at
WHERE orders.tenant_id = EXCLUDED.tenant_id"""
`;

const PG_LITERAL_VIOLATION = `
MULTI_TENANT = True
SQL = """INSERT INTO orders (id, tenant_id, total) VALUES (%s, %s, %s)
ON CONFLICT (id) DO UPDATE SET total = EXCLUDED.total, updated_at = EXCLUDED.updated_at"""
`;

// half (a): the guard IS present, so a co-presence grep scores this CLEAN. The
// violation is that tenant_id is also assigned in the SET — the ownership flip.
const HALF_A_VIOLATION = `
MULTI_TENANT = True
SQL = """INSERT INTO orders (id, tenant_id, total) VALUES (%s, %s, %s)
ON CONFLICT (id) DO UPDATE SET total = EXCLUDED.total, tenant_id = EXCLUDED.tenant_id
WHERE orders.tenant_id = EXCLUDED.tenant_id"""
`;

const MYSQL_COMPLIANT = `
multi_tenant = True
SQL = ("INSERT INTO orders (id, tenant_id, total, version) VALUES (%s,%s,%s,%s) "
       "ON DUPLICATE KEY UPDATE "
       "total = IF(tenant_id = VALUES(tenant_id), VALUES(total), total), "
       "version = IF(tenant_id = VALUES(tenant_id), version + 1, version)")
`;

const MYSQL_VIOLATION = `
multi_tenant = True
SQL = ("INSERT INTO orders (id, tenant_id, total, version) VALUES (%s,%s,%s,%s) "
       "ON DUPLICATE KEY UPDATE total = VALUES(total), version = version + 1")
`;

// ── FALSE-POSITIVE poles: correct code a naive grep would flag ───────────────
const COMPOSITE_KEY = `
multi_tenant = True
SQL = "INSERT INTO orders (tenant_id, id, total) VALUES (%s,%s,%s) ON CONFLICT (tenant_id, id) DO UPDATE SET total = EXCLUDED.total"
`;
const CONFLICT_ON_VAR = `
multi_tenant = True
conflict_on = ["tenant_id", "id"]
sql = f"INSERT INTO {t} VALUES (...) ON CONFLICT ({', '.join(conflict_on)}) DO UPDATE SET {sets}"
`;
const DO_NOTHING = `
multi_tenant = True
SQL = "INSERT INTO orders (id, tenant_id) VALUES (%s,%s) ON CONFLICT (id) DO NOTHING"
`;

// ── KNOWN MISSES: the declared blind classes, pinned as SILENCE ──────────────
const B1_ORM = `
multi_tenant = True
stmt = insert(Order).values(**row).on_conflict_do_update(index_elements=["id"], set_=row)
`;
const B3_CONSTRAINT = `
multi_tenant = True
SQL = "INSERT INTO orders VALUES (...) ON CONFLICT ON CONSTRAINT uq_orders_id DO UPDATE SET total = EXCLUDED.total"
`;
const B5_NO_VOCAB = `
SQL = "INSERT INTO cache (k, v) VALUES (%s,%s) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v"
`;

// ── library-level bipolar cases ──────────────────────────────────────────────

function findings(text) {
  return lib.auditUpserts(text).findings;
}

check("PG fragment builder: violation FIRES half (b)", () => {
  const f = findings(PG_VIOLATION);
  return f.length === 1 && f[0].half === "b" && f[0].dialect === "postgres"
    ? true
    : `expected 1 half-b finding, got ${JSON.stringify(f)}`;
});

check("PG fragment builder: compliant pole is SILENT", () => {
  const f = findings(PG_COMPLIANT);
  return f.length === 0 ? true : `fired on correct code: ${JSON.stringify(f)}`;
});

check("PG literal: violation FIRES half (b)", () => {
  const f = findings(PG_LITERAL_VIOLATION);
  return f.length === 1 && f[0].half === "b" ? true : `got ${JSON.stringify(f)}`;
});

check("PG literal: compliant pole is SILENT", () => {
  const f = findings(PG_LITERAL_COMPLIANT);
  return f.length === 0 ? true : `fired on correct code: ${JSON.stringify(f)}`;
});

check("half (a): tenant_id assigned in SET FIRES even though the (b) guard is present", () => {
  const f = findings(HALF_A_VIOLATION);
  return f.length === 1 && f[0].half === "a"
    ? true
    : `a co-presence grep scores this clean; the detector must not: ${JSON.stringify(f)}`;
});

check("MySQL ODKU: violation FIRES half (b)", () => {
  const f = findings(MYSQL_VIOLATION);
  return f.length === 1 && f[0].half === "b" && f[0].dialect === "mysql"
    ? true
    : `got ${JSON.stringify(f)}`;
});

check("MySQL ODKU: per-column IF() guard is SILENT on both halves", () => {
  const f = findings(MYSQL_COMPLIANT);
  return f.length === 0 ? true : `fired on correct code: ${JSON.stringify(f)}`;
});

check("FALSE-POSITIVE pole: composite conflict key (tenant_id, id) is SILENT", () => {
  const f = findings(COMPOSITE_KEY);
  return f.length === 0 ? true : `a cross-tenant id collision is not a conflict here: ${JSON.stringify(f)}`;
});

check("FALSE-POSITIVE pole: conflict_on variable carrying tenant_id is SILENT", () => {
  const f = findings(CONFLICT_ON_VAR);
  return f.length === 0 ? true : `fired on correct code: ${JSON.stringify(f)}`;
});

check("FALSE-POSITIVE pole: DO NOTHING is out of Rule 7's scope and is SILENT", () => {
  const r = lib.auditUpserts(DO_NOTHING);
  return r.findings.length === 0 && r.reason === "no-upsert-builder"
    ? true
    : `DO NOTHING overwrites nothing: ${JSON.stringify(r)}`;
});

check("enumerateUpsertBuilders finds BOTH dialects and no others", () => {
  const b = lib.enumerateUpsertBuilders(PG_LITERAL_VIOLATION + MYSQL_VIOLATION);
  const kinds = b.map((x) => x.dialect).sort();
  return kinds.length === 2 && kinds[0] === "mysql" && kinds[1] === "postgres"
    ? true
    : `got ${JSON.stringify(kinds)}`;
});

check("splitTopLevel keeps IF(tenant_id = VALUES(tenant_id), a, b) as ONE assignment", () => {
  const parts = lib.splitTopLevel("total = IF(tenant_id = VALUES(tenant_id), VALUES(total), total), v = 1");
  return parts.length === 2 ? true : `paren tracking broken: ${JSON.stringify(parts)}`;
});

check("setBodyAssignsTenant reads the LHS, not mere token presence", () => {
  const guarded = lib.setBodyAssignsTenant("total = IF(tenant_id = VALUES(tenant_id), VALUES(total), total)");
  const flipped = lib.setBodyAssignsTenant("total = EXCLUDED.total, tenant_id = EXCLUDED.tenant_id");
  return guarded === null && flipped !== null
    ? true
    : `guarded=${JSON.stringify(guarded)} flipped=${JSON.stringify(flipped)}`;
});

// ── KNOWN MISSES — asserted as silence, NOT as coverage ──────────────────────

check("KNOWN MISS B1 (ORM .on_conflict_do_update): SILENT — declared blind, not clean", () => {
  const f = findings(B1_ORM);
  return f.length === 0
    ? true
    : `B1 is declared unreachable; a finding here means the header is wrong: ${JSON.stringify(f)}`;
});

check("KNOWN MISS B3 (ON CONFLICT ON CONSTRAINT): SILENT and recorded as blind", () => {
  const r = lib.auditUpserts(B3_CONSTRAINT);
  return r.findings.length === 0 && r.blind.some((b) => b.klass === "B3")
    ? true
    : `must be recorded as blind, not clean: ${JSON.stringify(r)}`;
});

check("KNOWN MISS B4 (computed SET body): half (a) unreadable, recorded as blind", () => {
  const r = lib.auditUpserts(PG_COMPLIANT);
  return r.blind.some((b) => b.klass === "B4")
    ? true
    : `a placeholder SET body must be recorded blind: ${JSON.stringify(r.blind)}`;
});

check("KNOWN MISS B5 (no tenant vocabulary): SILENT and recorded as blind", () => {
  const r = lib.auditUpserts(B5_NO_VOCAB);
  return r.findings.length === 0 && r.reason === "not-tenant-aware" && r.blind.some((b) => b.klass === "B5")
    ? true
    : `must be recorded as out-of-scope, not clean: ${JSON.stringify(r)}`;
});

check("BLIND_LABELS names all six declared classes B1..B6", () => {
  const keys = Object.keys(lib.BLIND_LABELS).sort();
  return keys.join(",") === "B1,B2,B3,B4,B5,B6" ? true : `got ${keys.join(",")}`;
});

// ── scoping ──────────────────────────────────────────────────────────────────

check("isScannablePath accepts source, rejects markdown and self-referential trees", () => {
  const yes = lib.isScannablePath("src/db/upsert.py") && lib.isScannablePath("crates/db/src/upsert.rs");
  const no =
    !lib.isScannablePath(".claude/rules/tenant-isolation.md") &&
    !lib.isScannablePath(".claude/audit-fixtures/tenant-upsert-guard/run.mjs") &&
    !lib.isScannablePath("docs/upserts.md") &&
    !lib.isScannablePath("../outside/x.py");
  return yes && no ? true : `yes=${yes} no=${no}`;
});

// ── the REAL hook, as a REAL subprocess ──────────────────────────────────────

function runHook(dir, relFile, body, env = {}) {
  const abs = path.join(dir, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: abs },
  });
  const r = spawnSync(process.execPath, [GUARD], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
    timeout: 20000,
  });
  return r;
}

function fired(r) {
  return /tenant-isolation/.test(r.stdout || "") && /Rule 7/.test(r.stdout || "");
}

function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tenant-upsert-"));
}

check("hook end-to-end: FIRES on the PG violation, exit 0, advisory shape", () => {
  const r = runHook(mkdir(), "src/db/upsert.py", PG_VIOLATION);
  if (r.status !== 0) return `exited ${r.status}; an advisory must never block`;
  if (!fired(r)) return `no finding emitted: ${(r.stdout || "").slice(0, 200)}`;
  if (!/ADVISORY/.test(r.stdout)) return "not rendered as an advisory";
  if (/"continue":false/.test(r.stdout)) return "an advisory must not halt the session";
  return true;
});

check("hook end-to-end: SILENT on the PG compliant pole", () => {
  const r = runHook(mkdir(), "src/db/upsert.py", PG_COMPLIANT);
  return r.status === 0 && !fired(r) ? true : `fired on correct code: ${(r.stdout || "").slice(0, 300)}`;
});

check("hook end-to-end: FIRES on the MySQL violation, SILENT on its compliant twin", () => {
  const bad = runHook(mkdir(), "src/db/mysql.py", MYSQL_VIOLATION);
  const good = runHook(mkdir(), "src/db/mysql.py", MYSQL_COMPLIANT);
  if (!fired(bad)) return "MySQL violation not detected";
  if (fired(good)) return "fired on the guarded MySQL twin";
  return bad.status === 0 && good.status === 0 ? true : `status ${bad.status}/${good.status}`;
});

check("hook end-to-end: the advisory NAMES the blind classes so silence is not read as clean", () => {
  const r = runHook(mkdir(), "src/db/upsert.py", PG_VIOLATION);
  return /NOT evidence of compliance/.test(r.stdout || "") && /ON CONSTRAINT/.test(r.stdout || "")
    ? true
    : "the advisory must carry its own incompleteness";
});

check("hook end-to-end: a markdown file carrying the violating shape is SILENT (self-reference fence)", () => {
  const r = runHook(mkdir(), "docs/rules.md", PG_VIOLATION);
  return !fired(r) ? true : "the rule's own DO-NOT example must not trip its detector";
});

check("hook fails OPEN: no file_path, absent file, and an unparseable payload all pass through", () => {
  const d = mkdir();
  const mk = (input) =>
    spawnSync(process.execPath, [GUARD], {
      input,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: d },
      timeout: 20000,
    });
  for (const input of [
    JSON.stringify({ hook_event_name: "PostToolUse", tool_input: {} }),
    JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: path.join(d, "gone.py") } }),
    "{not json",
    "",
  ]) {
    const r = mk(input);
    if (r.status !== 0) return `exited ${r.status} on an UNKNOWN; must fail open`;
    if (fired(r)) return "fired on an UNKNOWN";
  }
  return true;
});

check("kill switch COC_TENANT_UPSERT=0 silences a genuine violation", () => {
  const r = runHook(mkdir(), "src/db/upsert.py", PG_VIOLATION, { COC_TENANT_UPSERT: "0" });
  return r.status === 0 && !fired(r) ? true : "kill switch did not disable the hook";
});

check("default-ON: an unset kill switch still detects", () => {
  const r = runHook(mkdir(), "src/db/upsert.py", PG_VIOLATION, { COC_TENANT_UPSERT: "" });
  return fired(r) ? true : "an empty kill switch must not disable coverage";
});

console.log("");
console.log(`tenant-upsert-guard fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
