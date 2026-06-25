#!/usr/bin/env node
/*
 * ============================================================================
 *  loom-doctor — onboarding health-check
 * ============================================================================
 *
 *  Surfaces EVERY onboarding issue at once with an actionable remediation per
 *  finding (brief point 5: "easy to track, highly transparent, informative").
 *
 *  Read-only DETECTION + bounded SAFE auto-repair (`--fix`) + a versioned
 *  `--json` schema and CI/ADO exit-code gateability (`--strict`).
 *
 *  Checks (all read-only):
 *    role          resolveRole() → platform|build|use-consumer|null
 *    node          process node version vs the supported floor
 *    git           presence + version (mandatory tool)
 *    line-endings  core.autocrlf + .gitattributes eol=lf contract
 *    merge-driver  coc-ledger 3-way merge driver registered (when used)
 *    gh            GitHub CLI presence + auth (needed for a GitHub host)
 *    az            Azure CLI presence + auth (needed for an ADO host)
 *    vcs-host      derived: at least one VCS host authenticated
 *    resolver      resolveAll() error cells / resolver-absent consumer
 *
 *  The engine (runDoctor / runFix) takes injectable seams (exec / fs /
 *  role+resolver fns / nodeVersion) so the unit tests drive deterministic
 *  fixtures without touching the real environment. `--fix` writes ONLY to the
 *  fixed SAFE-repair surface (git config, .coc-role, the resolver seed) and
 *  NEVER to hook-mediated state (posture.json / coordination-log / roster).
 *
 *  Usage:
 *    node .claude/bin/loom-doctor.mjs                  human report
 *    node .claude/bin/loom-doctor.mjs --json           machine-readable schema
 *    node .claude/bin/loom-doctor.mjs --strict         exit non-zero on CRIT (CI/ADO)
 *    node .claude/bin/loom-doctor.mjs --fix [--role R] apply bounded SAFE repairs
 *    node .claude/bin/loom-doctor.mjs --help
 *
 *  Exit codes: 0 = clean (or interactive). 1 = a CRIT finding under a gating
 *  flag (--strict / --json). Run `loom doctor` BEFORE /onboard.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveRole as realResolveRole,
  resolveAll as realResolveAll,
  isConfigured as realIsConfigured,
  LinkError,
  VALID_ROLES, // single source of truth (closed role set, D2) — imported, not re-declared
} from "./lib/loom-links.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ is bin/lib, so REPO_ROOT is two levels up from bin/ → .claude/ → root.
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const NODE_FLOOR_MAJOR = 18; // matches the runtime-prerequisite doc (W1-c)
const STATUS = Object.freeze({ ok: "ok", warn: "warn", crit: "crit", info: "info" });

// ── injectable seams ────────────────────────────────────────────────────────

// Run an external tool read-only. Returns a normalized shape that never throws:
//   { ok, missing, code, stdout, stderr }   — missing:true ⇒ tool not installed.
function defaultExec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  if (r.error) {
    return r.error.code === "ENOENT"
      ? { ok: false, missing: true }
      : { ok: false, missing: false, error: String(r.error) };
  }
  return {
    ok: r.status === 0,
    missing: false,
    code: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null; // absent → null (back-compat with the loom-links marker pattern)
  }
}

// ── individual checks (each pure given its injected deps) ────────────────────

function checkRole(resolveRole) {
  try {
    const role = resolveRole();
    if (role) {
      return mk("role", STATUS.ok, `this clone's role: ${role}`);
    }
    return mk(
      "role",
      STATUS.warn,
      "no role declared for this clone",
      "ratify with `loom doctor --fix --role <platform|build|use-consumer>` " +
        "(writes a `.coc-role` marker), or add `role:` to loom-links.local.json",
    );
  } catch (e) {
    const msg = e instanceof LinkError ? `${e.subtype}: ${e.message}` : String(e);
    return mk(
      "role",
      STATUS.crit,
      `role resolution failed — ${msg}`,
      "fix the malformed role value in loom-links.local.json or .coc-role " +
        "(must be one of {platform, build, use-consumer})",
    );
  }
}

function checkNode(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (Number.isFinite(major) && major >= NODE_FLOOR_MAJOR) {
    return mk("node", STATUS.ok, `node v${nodeVersion} (≥ ${NODE_FLOOR_MAJOR})`);
  }
  return mk(
    "node",
    STATUS.crit,
    `node v${nodeVersion} is below the supported floor (v${NODE_FLOOR_MAJOR})`,
    `install Node ≥ ${NODE_FLOOR_MAJOR} (the .claude/bin scripts require it)`,
  );
}

function checkGit(exec) {
  const r = exec("git", ["--version"]);
  if (r.missing) {
    return mk("git", STATUS.crit, "git is not installed", "install git — it is mandatory for every COC clone");
  }
  if (!r.ok) {
    return mk("git", STATUS.warn, "`git --version` returned non-zero", "check the git installation");
  }
  return mk("git", STATUS.ok, r.stdout || "git present");
}

function checkLineEndings(exec, readFile) {
  const cfg = exec("git", ["config", "--get", "core.autocrlf"]);
  const autocrlf = cfg.ok ? cfg.stdout : ""; // unset → "" (git returns non-zero/empty)
  const attrs = readFile(path.join(REPO_ROOT, ".gitattributes")) || "";
  const hasEolContract = /(^|\n)\s*\*\s+text=auto/.test(attrs) || /eol=lf/.test(attrs);

  if (autocrlf === "true") {
    return mk(
      "line-endings",
      STATUS.warn,
      "core.autocrlf=true conflicts with the eol=lf normalization",
      "run `git config core.autocrlf false` (or `loom doctor --fix`)",
    );
  }
  if (!hasEolContract) {
    return mk(
      "line-endings",
      STATUS.info,
      "no `* text=auto` / `eol=lf` contract found in .gitattributes",
      "expected only in repos carrying the W1-a normalization; informational for others",
    );
  }
  return mk("line-endings", STATUS.ok, `core.autocrlf=${autocrlf || "unset"}; eol=lf contract present`);
}

function checkMergeDriver(exec, readFile) {
  const attrs = readFile(path.join(REPO_ROOT, ".gitattributes")) || "";
  if (!/merge=coc-ledger/.test(attrs)) {
    return mk("merge-driver", STATUS.info, "no coc-ledger merge driver referenced in .gitattributes");
  }
  const drv = exec("git", ["config", "--get", "merge.coc-ledger.driver"]);
  if (drv.ok && drv.stdout) {
    return mk("merge-driver", STATUS.ok, "coc-ledger merge driver registered");
  }
  return mk(
    "merge-driver",
    STATUS.warn,
    ".gitattributes uses merge=coc-ledger but the driver is not registered in git config",
    "run `loom doctor --fix` to register merge.coc-ledger.{name,driver}; without it, " +
      ".session-notes.shared.md 3-way merges fall back to the default driver and clobber rows",
  );
}

// GitHub / Azure CLI: presence THEN auth, folded into one check each.
function checkHostCli(exec, cmd, label, versionArgs, authArgs, authHint) {
  const ver = exec(cmd, versionArgs);
  if (ver.missing) {
    return mk(
      label,
      STATUS.info,
      `${cmd} not installed`,
      `install ${cmd} only if this clone targets a ${authHint} host`,
      { authed: false },
    );
  }
  const auth = exec(cmd, authArgs);
  if (auth.ok) {
    return mk(label, STATUS.ok, `${cmd} present and authenticated`, null, { authed: true });
  }
  return mk(
    label,
    STATUS.warn,
    `${cmd} present but not authenticated`,
    `run the ${cmd} login flow if this clone targets a ${authHint} host`,
    { authed: false },
  );
}

function checkVcsHost(ghCheck, azCheck) {
  const ready = [];
  if (ghCheck.authed) ready.push("GitHub");
  if (azCheck.authed) ready.push("Azure DevOps");
  if (ready.length > 0) {
    return mk("vcs-host", STATUS.ok, `VCS host ready: ${ready.join(", ")}`);
  }
  return mk(
    "vcs-host",
    STATUS.warn,
    "no VCS host authenticated (neither gh nor az)",
    "authenticate the CLI for your host before /onboard or a genesis ceremony",
  );
}

function checkResolver(isConfigured, resolveAll) {
  if (!isConfigured()) {
    return mk(
      "resolver",
      STATUS.info,
      "loom-links resolver not configured",
      "expected for a USE-consumer clone; run `loom-links-init.mjs` to declare repo links " +
        "(or `loom doctor --fix` seeds it)",
    );
  }
  let errors;
  try {
    const all = resolveAll(); // NOTE: resolveAll() takes NO opts (G3 correction)
    errors = [...all.entries()].filter(([, v]) => v.kind === "error");
  } catch (e) {
    return mk("resolver", STATUS.crit, `resolver load failed — ${String(e)}`, "fix loom-links.local.json");
  }
  if (errors.length === 0) {
    return mk("resolver", STATUS.ok, "all declared repo links resolve");
  }
  const names = errors.map(([k]) => k).join(", ");
  return mk(
    "resolver",
    STATUS.warn,
    `${errors.length} repo link(s) fail to resolve: ${names}`,
    "fix the failing path(s) in loom-links.local.json (each is an explicit not-found, not a guess)",
  );
}

// ── engine ───────────────────────────────────────────────────────────────────

function mk(id, status, detail, remediation = null, extra = {}) {
  return { id, status, detail, remediation, ...extra };
}

/**
 * Run every read-only check and return a structured result.
 * All environment access is via injectable seams so tests stay deterministic.
 * @returns {{schema_version:number, checks:object[], summary:object}}
 */
export function runDoctor(opts = {}) {
  const {
    resolveRole = realResolveRole,
    resolveAll = realResolveAll,
    isConfigured = realIsConfigured,
    exec = defaultExec,
    readFile = defaultReadFile,
    nodeVersion = process.versions.node,
  } = opts;

  const gh = checkHostCli(exec, "gh", "gh", ["--version"], ["auth", "status"], "GitHub");
  const az = checkHostCli(exec, "az", "az", ["--version"], ["account", "show"], "Azure DevOps");

  const checks = [
    checkRole(resolveRole),
    checkNode(nodeVersion),
    checkGit(exec),
    checkLineEndings(exec, readFile),
    checkMergeDriver(exec, readFile),
    gh,
    az,
    checkVcsHost(gh, az),
    checkResolver(isConfigured, resolveAll),
  ];

  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    },
    { ok: 0, warn: 0, crit: 0, info: 0 },
  );

  return { schema_version: 1, checks, summary };
}

// ── human report ──────────────────────────────────────────────────────────────

const GLYPH = { ok: "✓", warn: "!", crit: "✗", info: "·" };

export function formatReport(result) {
  const lines = ["loom doctor — onboarding health-check", ""];
  for (const c of result.checks) {
    lines.push(`  ${GLYPH[c.status] || "?"} [${c.status.toUpperCase()}] ${c.id}: ${c.detail}`);
    if (c.remediation) lines.push(`        → ${c.remediation}`);
  }
  const s = result.summary;
  lines.push("");
  lines.push(`  ${s.ok} ok · ${s.warn} warn · ${s.crit} crit · ${s.info} info`);
  if (s.crit > 0 || s.warn > 0) {
    lines.push("  Address the items above before /onboard, or run `loom doctor --fix`.");
  } else {
    lines.push("  All checks clean. Ready for /onboard.");
  }
  return lines.join("\n");
}

// ── bounded SAFE auto-repair ─────────────────────────────────────────────────
//
// runFix writes ONLY to the fixed SAFE-repair surface below. It MUST NEVER
// touch hook-mediated protected state — posture.json / coordination-log.jsonl /
// operators.roster.json (`multi-operator-coordination.md` MUST NOT). Every
// repair is local + reversible + idempotent. The role write requires an
// EXPLICIT --role (NO silent guess — the D2 precedence design).

const COC_LEDGER_NAME = "COC forest-ledger 3-way merge";
const COC_LEDGER_DRIVER = ".claude/hooks/lib/coc-ledger.js %O %A %B %P";

// Default seam: invoke the existing loom-links-init seeder (refuses-on-exists).
function defaultInvokeInit() {
  const init = path.join(SCRIPT_DIR, "loom-links-init.mjs");
  const r = spawnSync(process.execPath, [init, "--write"], { encoding: "utf8", timeout: 5000 });
  const tail = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop() || "";
  return { ok: r.status === 0, detail: tail };
}

/**
 * Apply bounded SAFE repairs for the findings in `result`. Injectable seams
 * (exec / writeFile / invokeInit / cocRolePath / role) keep it test-deterministic.
 * @returns {{applied:string[], skipped:string[], manual:string[]}}
 */
export function runFix(result, opts = {}) {
  const {
    exec = defaultExec,
    writeFile = (p, c) => fs.writeFileSync(p, c),
    invokeInit = defaultInvokeInit,
    cocRolePath = path.join(REPO_ROOT, ".coc-role"),
    role = null, // explicit --role value; NO silent guess (D2)
  } = opts;

  const applied = [];
  const skipped = [];
  const manual = [];
  const byId = (id) => result.checks.find((c) => c.id === id);

  // line-endings: core.autocrlf=true → false (local git config, reversible)
  if (byId("line-endings")?.status === "warn") {
    const r = exec("git", ["config", "core.autocrlf", "false"]);
    (r.ok ? applied : skipped).push(`core.autocrlf=false${r.ok ? "" : " (git config failed)"}`);
  }

  // merge-driver: register name + driver (the canonical .gitattributes contract)
  if (byId("merge-driver")?.status === "warn") {
    const r1 = exec("git", ["config", "merge.coc-ledger.name", COC_LEDGER_NAME]);
    const r2 = exec("git", ["config", "merge.coc-ledger.driver", COC_LEDGER_DRIVER]);
    (r1.ok && r2.ok ? applied : skipped).push(
      `merge.coc-ledger driver registered${r1.ok && r2.ok ? "" : " (git config failed)"}`,
    );
  }

  // resolver: seed loom-links.local.json via the existing seeder (refuses-on-exists)
  if (byId("resolver")?.status === "info") {
    const r = invokeInit();
    (r.ok ? applied : skipped).push(`loom-links.local.json seed${r.detail ? ` — ${r.detail}` : ""}`);
  }

  // role: write .coc-role ONLY with an explicit, valid --role (NO silent guess, D2)
  if (byId("role")?.status === "warn") {
    if (!role) {
      manual.push(
        "role undeclared — re-run `loom doctor --fix --role <platform|build|use-consumer>` to ratify (no silent guess, D2)",
      );
    } else if (!VALID_ROLES.has(role)) {
      manual.push(`--role "${role}" is invalid — must be one of {${[...VALID_ROLES].join(", ")}}`);
    } else {
      writeFile(cocRolePath, role + "\n");
      applied.push(`.coc-role = ${role}`);
    }
  }

  return { applied, skipped, manual };
}

export function formatFixReport(fix) {
  const lines = ["loom doctor --fix"];
  for (const a of fix.applied) lines.push(`  ✓ applied: ${a}`);
  for (const s of fix.skipped) lines.push(`  ! skipped: ${s}`);
  for (const m of fix.manual) lines.push(`  · manual:  ${m}`);
  if (!fix.applied.length && !fix.skipped.length && !fix.manual.length) {
    lines.push("  (nothing to repair)");
  }
  return lines.join("\n");
}

// ── CLI (--json schema + CI/ADO exit-code gateability) ───────────────────────

export function parseFlags(argv) {
  const flags = { help: false, json: false, fix: false, strict: false, role: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--fix") flags.fix = true;
    else if (a === "--strict") flags.strict = true;
    else if (a === "--role") flags.role = argv[++i] ?? null;
    else if (a.startsWith("--role=")) flags.role = a.slice("--role=".length);
  }
  return flags;
}

// CI/ADO gateability: exit non-zero on CRIT ONLY when gating
// (--strict or --json). Interactive runs stay exit 0 so a human report never
// trips a shell `set -e`.
export function exitCode(result, flags) {
  if ((flags.strict || flags.json) && result.summary.crit > 0) return 1;
  return 0;
}

const HELP = [
  "loom-doctor — onboarding health-check",
  "",
  "Usage:",
  "  node .claude/bin/loom-doctor.mjs                 human report",
  "  node .claude/bin/loom-doctor.mjs --json          machine-readable (versioned schema)",
  "  node .claude/bin/loom-doctor.mjs --strict        exit non-zero on any CRIT (CI/ADO gate)",
  "  node .claude/bin/loom-doctor.mjs --fix [--role R]  apply bounded SAFE repairs",
  "  node .claude/bin/loom-doctor.mjs --help",
  "",
  "Checks role, node/git/gh/az, line-endings, the coc-ledger merge driver,",
  "VCS-host auth, and the resolver — all at once, each with a remediation.",
  "--fix repairs the safe subset (autocrlf, merge-driver, resolver seed, and",
  "the .coc-role marker with an explicit --role); it never touches hook-mediated",
  "state. Run `loom doctor` BEFORE /onboard.",
  "",
];

function main(argv) {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP.join("\n") + "\n");
    return 0;
  }
  const result = runDoctor();

  if (flags.fix) {
    const fix = runFix(result, { role: flags.role });
    process.stdout.write(formatFixReport(fix) + "\n\n");
    const after = runDoctor(); // reflect post-repair state
    process.stdout.write(formatReport(after) + "\n");
    return exitCode(after, flags);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return exitCode(result, flags);
  }

  process.stdout.write(formatReport(result) + "\n");
  return exitCode(result, flags);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
