/**
 * coc-ledger-driver — single source of truth for the `coc-ledger` git merge
 * driver registration, shared by the `loom doctor` health-check/repair (ESM,
 * imports this CJS module) and the SessionStart self-heal (CJS, requires it).
 *
 * WHY a shared module: the canonical driver COMMAND string is the drift-prone
 * datum — a pre-loom#741 clone registered the BARE path
 * `.claude/hooks/lib/coc-ledger.js %O %A %B` which, because coc-ledger.js is
 * committed mode 100644 (non-executable), fails `Permission denied` under
 * git's shell exec and SILENTLY falls back to the default line-merge, clobbering
 * `.session-notes.shared.md` rows (loom#741; RISK journal/0418 G1). Duplicating
 * the canonical string across loom-doctor + a hook would re-open that exact
 * bare-vs-node drift. This module owns it once.
 *
 * `%P` is DELIBERATELY OMITTED from CANONICAL_DRIVER: it expands to the merged
 * file's repo-relative path and, via the `workspaces/*` .gitattributes binding,
 * is a shell-injection surface (a maliciously-named dir); the driver reads only
 * `%O %A %B`. Do NOT re-add it. (loom#741 R1 security.)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  resolveGitBinary,
  gitConfigInvocation,
} = require("./git-subprocess-env.js");

// SSOT — MUST byte-match loom-doctor's registration + the .gitattributes
// canonical-command comment. loom-doctor.mjs imports these; do not fork.
const CANONICAL_DRIVER = "node .claude/hooks/lib/coc-ledger.js %O %A %B";
const CANONICAL_NAME = "COC forest-ledger 3-way merge";

/** True when .gitattributes opts this repo into the coc-ledger merge driver. */
function gitattributesReferencesDriver(gitattributesText) {
  return /merge=coc-ledger/.test(gitattributesText || "");
}

/** True when a registered `merge.coc-ledger.driver` value is the canonical one. */
function isCanonicalDriver(value) {
  return (value || "").trim() === CANONICAL_DRIVER;
}

// Default injectable seams (overridable in tests). Mirror loom-doctor's shape:
// exec(cmd, args) -> { ok, stdout }.
//
// loom#1471 shard F1 — this ran a LITERAL `git` with NO `env:`, so an ambient
// GIT_DIR / GIT_CONFIG_GLOBAL / GIT_CONFIG_COUNT decided both what the driver
// probe SAW and, on the write path, which repository got configured. It routes
// through the CONFIG profile rather than `gitEnv()` because the question it asks
// is a CONFIG question: a driver registered in the operator's GLOBAL config is
// genuinely in force at merge time, and `gitEnv()` — which nulls global and
// system config — would report it missing and write a redundant local copy.
// See git-subprocess-env.js § "the CONFIG profile".
//
// FAIL-CLOSED: an unresolvable git returns `{ok:false}`, which every caller
// already treats as "could not read / could not write" — never as "registered".
function defaultExec(cmd, args) {
  try {
    if (cmd !== "git") return { ok: false, stdout: "" };
    const gitBin = resolveGitBinary();
    if (!gitBin) return { ok: false, stdout: "" };
    const inv = gitConfigInvocation(args);
    const r = spawnSync(gitBin, inv.args, {
      encoding: "utf8",
      env: inv.env,
      timeout: 5000,
    });
    return { ok: r.status === 0, stdout: r.stdout || "" };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Self-heal: register the canonical coc-ledger driver in local git config when
 * this repo uses the ledger (.gitattributes) AND the registration is missing or
 * non-canonical. LOCAL git config only — per-clone, reversible, idempotent.
 * FAIL-OPEN by construction: any error returns a benign `{status:"error"}` and
 * writes nothing that could break; callers treat every non-"repaired" status as
 * a no-op.
 *
 * @returns {{status:"not-referenced"|"ok"|"repaired-unregistered"|"repaired-non-canonical"|"error",
 *            action:"none"|"registered", before:(string|null), error?:string}}
 */
function ensureCanonicalDriver(opts = {}) {
  const {
    // The OPTION is still named `exec` — it is the public injection seam,
    // mirrored from loom-doctor's shape, and every test binds it. The LOCAL
    // binding is renamed because the regrowth guard's detector counts a spawner
    // NAME, so `exec("git", …)` reads to it as a literal-git subprocess even
    // though it is an injected function call. Its header already records this
    // exact collision as the reason a textual count was wrong for this file;
    // renaming the local removes the false positive at the source instead of
    // ledgering a row that is not real debt.
    repoRoot = process.cwd(),
    exec: runGit = defaultExec,
    readFile = defaultReadFile,
  } = opts;
  try {
    const attrs = readFile(path.join(repoRoot, ".gitattributes"));
    if (!gitattributesReferencesDriver(attrs)) {
      return { status: "not-referenced", action: "none", before: null };
    }
    // `-C repoRoot` on EVERY invocation (loom#1471 shard F1). These three calls
    // previously ran with no `-C` and no `cwd:`, so they read and WROTE whatever
    // repository `process.cwd()` happened to discover — while `.gitattributes`
    // was read from `repoRoot` two lines up. On a session started in a linked
    // worktree or a nested repo those are different repositories, so the probe
    // could answer about one clone and the self-heal register the driver in
    // another. `-C` chooses a DIRECTORY, which is exactly the pin wanted here;
    // the REPOSITORY-choosing family (GIT_DIR et al.) stays denied by the
    // profile, so this cannot be re-steered from the environment.
    const g = (...args) => runGit("git", ["-C", repoRoot, ...args]);
    const cur = g("config", "--get", "merge.coc-ledger.driver");
    const before = cur.ok && cur.stdout ? cur.stdout.trim() : null;
    if (before !== null && isCanonicalDriver(before)) {
      return { status: "ok", action: "none", before };
    }
    // Missing or non-canonical → register both name + driver.
    const r1 = g("config", "merge.coc-ledger.name", CANONICAL_NAME);
    const r2 = g("config", "merge.coc-ledger.driver", CANONICAL_DRIVER);
    if (!r1.ok || !r2.ok) {
      return {
        status: "error",
        action: "none",
        before,
        error: "git config write failed",
      };
    }
    return {
      status:
        before === null ? "repaired-unregistered" : "repaired-non-canonical",
      action: "registered",
      before,
    };
  } catch (e) {
    return {
      status: "error",
      action: "none",
      before: null,
      error: String(e && e.message),
    };
  }
}

module.exports = {
  CANONICAL_DRIVER,
  CANONICAL_NAME,
  gitattributesReferencesDriver,
  isCanonicalDriver,
  ensureCanonicalDriver,
};
