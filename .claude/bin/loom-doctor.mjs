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
 *    ado-readiness ADO org/project config-presence (skip on a non-ADO clone)
 *    resolver      resolveAll() error cells / resolver-absent consumer
 *
 *  OPT-IN check (network; NOT part of the default run — see the section
 *  "Gate-2 target protection" below):
 *    gate2-target:<key>  per-target branch-protection report (`--targets`)
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
 *    node .claude/bin/loom-doctor.mjs --targets        probe Gate-2 target protection
 *    node .claude/bin/loom-doctor.mjs --help
 *
 *  Exit codes: 0 = clean (or interactive). 1 = a CRIT finding under a gating
 *  flag (--strict / --json). Run `loom doctor` BEFORE /onboard.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

// loom#1471 regrowth guard: every git this repo spawns MUST route through the
// shared envelope (absolute binary + constants-built env), per
// `rules/security.md` § Enforcement-Surface Parity. Loaded via createRequire
// (the module is CommonJS — the established .mjs->CJS bridge in this dir) and
// GUARDED, because a load-time throw would kill even `--help` in a tool whose
// whole job is to report health rather than die.
//
// WHERE IT IS APPLIED IN THIS FILE: `defaultExec` — the only place this file
// spawns git — via `isGitCommand` + `gitEnvelope`. The call sites keep passing
// the literal `"git"` because that string is an argument to the INJECTED SEAM
// (`exec`), which spawns nothing; the seam's DEFAULT is what spawns, and that is
// where both halves are applied.
const _require = createRequire(import.meta.url);
let _gitSubprocessEnv = null;
try {
  _gitSubprocessEnv = _require("../hooks/lib/git-subprocess-env.js");
} catch {
  _gitSubprocessEnv = null; // absent -> fail CLOSED at the call site, never ambient
}

// loom-links is the resolver SSOT AT LOOM, but it is fenced `loom_only` and is
// therefore ABSENT at a USE-consumer clone (F1030a). loom-doctor backs the
// default-surfaced `/doctor`, so it MUST load + run without it. Load it lazily:
// module present → the real resolver functions; module absent → safe degraded
// stand-ins that report role/resolver as WARN/INFO (never crash). This is the
// ONE intended degrade path (the catch → null), documented per zero-tolerance
// Rule 3 — it is NOT silent error hiding.
async function loadLoomLinks() {
  try {
    return await import("./lib/loom-links.mjs");
  } catch {
    return null; // fenced/absent at a consumer — degrade, do not crash
  }
}
const loomLinks = await loadLoomLinks();

// The ecosystem config declares the Gate-2 remote_links the `--targets` check
// enumerates. Same lazy-degrade shape as loom-links (it may be fenced/absent at
// a consumer clone), with ONE difference that matters: a module that is ABSENT
// is a degrade (no Gate-2 targets exist to report on), while a config that is
// PRESENT-BUT-MALFORMED is a real fault and is carried out as `error` so the
// check surfaces it LOUD rather than reporting zero targets (zero-tolerance
// Rule 3 — no silent fallback; "0 targets" and "config broken" must not print
// the same thing).
async function loadEcosystem() {
  try {
    const m = await import("./lib/ecosystem-config.mjs");
    return { config: m.getEcosystemConfig(), error: null };
  } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND") return { config: null, error: null };
    return { config: null, error: String((e && e.message) || e) };
  }
}
const ecosystem = await loadEcosystem();

// Mirror of loom-links VALID_ROLES; loom-links may be fenced at a consumer, so
// loom-doctor carries a local fallback copy. loom-links.mjs stays the SSOT at
// loom — the real set is used whenever the module loaded.
const VALID_ROLES_FALLBACK = new Set(["platform", "build", "use-consumer"]);
// SSOT for the coc-ledger driver registration — shared with the SessionStart
// self-heal (journal/0418 G1). The canonical-command string + %P-omission
// rationale live in the lib; do NOT re-declare a local copy (that bare-vs-node
// drift IS loom#741).
import {
  CANONICAL_DRIVER as COC_LEDGER_DRIVER,
  CANONICAL_NAME as COC_LEDGER_NAME,
} from "../hooks/lib/coc-ledger-driver.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ is bin/lib, so REPO_ROOT is two levels up from bin/ → .claude/ → root.
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const NODE_FLOOR_MAJOR = 18; // matches the runtime-prerequisite doc (W1-c)
const STATUS = Object.freeze({ ok: "ok", warn: "warn", crit: "crit", info: "info" });

// ── injectable seams ────────────────────────────────────────────────────────

/**
 * THE single predicate for "is this seam call a git invocation".
 *
 * The six git call sites pass the LITERAL `"git"` (that literal is the SEAM's
 * argument, not a spawned command — the only spawn in this file's tool runner is
 * the one below), and `ownOriginSlug` passes an already-resolved absolute binary.
 * Both are git; `gh`, `az` and `node` are not.
 *
 * ONE predicate, not two, deliberately: a second copy written at the gate and a
 * first copy written at the envelope is precisely the drift shape
 * `rules/security.md` § Multi-Site Kwarg Plumbing forbids — the two would
 * disagree on some input and the looser one would decide. `resolveGitBinary()`
 * is memoized in the helper, so asking it here is cheap.
 */
function isGitCommand(cmd) {
  if (cmd === "git") return true;
  if (typeof cmd !== "string" || !_gitSubprocessEnv) return false;
  try {
    const bin = _gitSubprocessEnv.resolveGitBinary();
    return bin !== null && cmd === bin;
  } catch {
    return false;
  }
}

/**
 * The git envelope for one invocation, or null when it cannot be built.
 *
 * WHY THE ENVELOPE IS BUILT HERE AND NOT AT THE CALL SITES (loom#1471). This
 * function holds this file's ONLY `git` spawn, so it is the one place where
 * "which repository answers" is actually decided. Resolving the binary closes
 * PATH planting; it closes NOTHING ELSE. `GIT_DIR` outranks repository
 * DISCOVERY, and neither `-C` nor `cwd:` pins a REPOSITORY — both only choose a
 * DIRECTORY — so an ambient `GIT_DIR` still re-points the child at an
 * attacker's repository. The env half is what closes that, and it was missing
 * here while `ownOriginSlug` carried the binary half alone.
 *
 * PROFILE SELECTION, which is a correctness decision and not a formality.
 * `gitEnv()` sets `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL=/dev/null` +
 * `GIT_CONFIG_SYSTEM=/dev/null`, so a `git config --get` under it reads ONLY the
 * local repo. MEASURED, two poles on one tree, with a GLOBAL-only value planted:
 *
 *   HOME=<planted> git config --get core.autocrlf                    -> "true", exit 0
 *   env -i … GIT_CONFIG_GLOBAL=/dev/null … git config --get core.autocrlf
 *                                                                    -> empty,  exit 1
 *
 * `core.autocrlf=true` is set GLOBALLY by the Git-for-Windows installer, and
 * detecting it is the entire point of `checkLineEndings`. So routing the config
 * READS through `gitEnv()` would not harden this tool, it would BLIND it — the
 * check would report `ok` on exactly the host it exists to warn. Config
 * questions therefore take `gitConfigInvocation()`, the steering-closed,
 * config-PRESERVING profile built for this case (it admits global/system config,
 * derives `HOME` from the passwd database rather than forwarding it, prefixes
 * the pager/credential/fsmonitor neutralizers, and refuses any subcommand
 * outside its allowlist). Everything else — `--version`, `remote get-url` — is a
 * plain local query and takes the TIGHTER `gitEnvForArgs()`, least privilege.
 *
 * FAIL-CLOSED, NEVER AMBIENT. A missing helper or an unresolvable binary returns
 * null, and the caller degrades that to a non-ok result. It does NOT fall back
 * to spawning git with the inherited environment — that fallback is the whole
 * defect (`rules/zero-tolerance.md` Rule 3).
 */
function gitEnvelope(args) {
  if (!_gitSubprocessEnv) return null;
  let bin;
  try {
    bin = _gitSubprocessEnv.resolveGitBinary();
  } catch {
    return null;
  }
  if (!bin) return null;
  try {
    if (Array.isArray(args) && args[0] === "config") {
      const inv = _gitSubprocessEnv.gitConfigInvocation(args);
      return { bin, args: inv.args, env: inv.env };
    }
    return { bin, args, env: _gitSubprocessEnv.gitEnvForArgs(args) };
  } catch {
    // A refused profile (GitConfigProfileError) is a programming error, not a
    // host condition. Surface it as a failed check rather than letting it throw
    // out of a health-check whose contract is to report — and NEVER by falling
    // back to a looser profile.
    return null;
  }
}

// Run an external tool read-only. Returns a normalized shape that never throws:
//   { ok, missing, code, stdout, stderr }   — missing:true ⇒ tool not installed.
//
// `git` is spawned through the shared envelope above (absolute binary +
// constants-built env). `gh` / `az` are NOT: they are not git, and they need the
// ambient `HOME` + token variables to answer an auth probe at all — handing them
// `gitEnv()` would make every host-CLI check report "not authenticated" on a
// correctly authenticated clone. That boundary is deliberate, and it is the
// reason the envelope is selected per-invocation rather than applied to the
// whole function.
function normalizeSpawn(r) {
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

function defaultExec(cmd, args) {
  // ── the git branch ────────────────────────────────────────────────────────
  // WRITTEN AS ITS OWN `spawnSync` STATEMENT, and that shape is load-bearing
  // rather than stylistic. Folding both branches into one call with a
  // conditionally-spread `...(env ? { env } : {})` is what the first draft did,
  // and it is INVISIBLE to the loom#1471 regrowth guard in two ways at once: the
  // command expression was the neutral identifier `spawnCmd`, which
  // `isGitBoundCommand` does not recognise, and a conditional spread reads as an
  // `env:` key whether or not one is ever passed. Naming the command `gitBin`
  // and passing `env:` UNCONDITIONALLY puts this site inside G9's ratchet
  // ("every RESOLVED-BINARY git spawn passes an env — in EVERY file, ledgered or
  // not"), so deleting the env here reds a guard instead of silently restoring
  // the defect. MEASURED before the split: dropping the env changed a real
  // finding (`merge-driver` ok -> warn under an ambient GIT_DIR) while every
  // suite in the tree stayed green.
  if (isGitCommand(cmd)) {
    const envelope = gitEnvelope(args);
    if (!envelope) {
      return {
        ok: false,
        missing: false,
        error:
          "git-subprocess-env envelope unavailable (helper absent, binary unresolvable, or " +
          "profile refused) — refusing to spawn git with the inherited environment",
      };
    }
    const gitBin = envelope.bin;
    return normalizeSpawn(
      spawnSync(gitBin, envelope.args, { encoding: "utf8", timeout: 5000, env: envelope.env }),
    );
  }
  // ── the non-git branch: `gh` / `az`, deliberately ambient ──────────────────
  // See the note above the function: these need the ambient HOME + token
  // variables to answer an auth probe, so they are NOT given a git profile.
  return normalizeSpawn(spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 }));
}

function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    // ENOENT is a real ANSWER (absent -> null). Every other errno is NOT, and the
    // bare catch this replaced folded all of them into absence -- the same fold
    // defaultStatFile was written to refuse 20 lines below, in the same file, for
    // the same reason. Found by adversarial security review 2026-09-20:
    //   (a) an UNREADABLE delegate read as delegate-ABSENT, which arm (0) reports
    //       as n/a -- the single most reassuring verdict available -- on the repo
    //       whose only trunk gate this is;
    //   (b) an unreadable hook BODY read as absent-does-not-delegate, a definite
    //       diagnosis of a file the check never read.
    // Both are instrument-discipline.md MUST-1: a permission failure means the
    // check COULD NOT LOOK, and that is not a finding about the subject.
    if (err && err.code === "ENOENT") return null;
    return {
      readError: ((err && err.code) || "read failed") + ": " + ((err && err.message) || String(err)),
    };
  }
}

/**
 * Normalise a read seam return into {text, error}.
 *
 * The seam is INJECTED, so a test or fixture may hand back a bare string, a null,
 * or the error envelope above. Collapsing that here keeps every call site from
 * re-deciding, which is how the two misverdicts arose: three read sites, each
 * applying its own !== null or typeof === "string" test.
 */
function readOutcome(readFile, p) {
  const r = readFile(p);
  if (r && typeof r === "object" && typeof r.readError === "string") {
    return { text: null, error: r.readError };
  }
  return { text: typeof r === "string" ? r : null, error: null };
}

/**
 * Stat seam: `{exists, executable}` — or `{error}` when the answer is UNKNOWN.
 *
 * WHY THIS IS NOT `readFile !== null`. The executable bit decides whether git
 * honours a hook at all, and it is invisible to a content read. MEASURED on
 * git 2.54.0: a `pre-commit` present but mode 0644 is IGNORED — git prints
 * `hint: ... not set as executable`, the commit LANDS, and rc is 0. A
 * presence-only predicate scores that state INSTALLED, which is the exact false
 * clean this check exists to prevent.
 *
 * ENOENT is a real ANSWER (absent). Every other errno is NOT: a permission
 * failure means the check could not look, and collapsing that into "absent"
 * would manufacture a `crit` out of an unknown — the fold
 * `instrument-discipline.md` MUST-1 forbids, in the direction that looks
 * responsible.
 */
function defaultStatFile(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, executable: (st.mode & 0o111) !== 0 };
  } catch (err) {
    if (err && err.code === "ENOENT") return { exists: false, executable: false };
    return { error: `${(err && err.code) || "stat failed"}: ${(err && err.message) || String(err)}` };
  }
}

// Default role/resolver seams: the real loom-links functions when the module
// loaded, else safe degraded stand-ins (F1030a — loom-links fenced at a
// consumer). These back runDoctor's default params so tests still inject fakes.
function realResolveRole() {
  return loomLinks ? loomLinks.resolveRole() : degradedResolveRole();
}
function realResolveAll() {
  return loomLinks ? loomLinks.resolveAll() : new Map();
}
function realIsConfigured() {
  // Module absent ⇒ not configured ⇒ checkResolver's INFO "expected for a
  // USE-consumer clone" branch fires (never the resolveAll crash path).
  return loomLinks ? loomLinks.isConfigured() : false;
}

// Degraded stand-in for resolveRole when loom-links is fenced/absent: read the
// repo-root `.coc-role` marker directly — the SAME D2 fallback the real
// resolveRole consults — so a consumer that ratified a role still resolves it.
// Absent/empty marker → null (→ the "no role declared" WARN path); never throws.
function degradedResolveRole() {
  const env = process.env.LOOM_COC_ROLE_MARKER;
  const markerPath =
    env && env.trim() !== "" && path.isAbsolute(env)
      ? env
      : path.join(REPO_ROOT, ".coc-role");
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return null; // absent → fall through to the "no role declared" WARN path
  }
  const token = raw.trim();
  return token === "" ? null : token;
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
    // Duck-type on the loom-links LinkError shape (`.subtype`) so no static
    // LinkError binding is needed — the module must load even when loom-links
    // is fenced at a consumer (F1030a).
    const msg =
      e && typeof e.subtype === "string" ? `${e.subtype}: ${e.message}` : String(e);
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
    // Registered — but a value that differs from the canonical command is a
    // STALE registration (e.g. a pre-loom#741 clone that registered the bare
    // non-executable path). git config persists, so such a clone stays on the
    // clobbering fallback forever unless we flag it for re-fix. A bare path
    // (no `node ` prefix) fails `Permission denied` under git's shell exec.
    if (drv.stdout.trim() === COC_LEDGER_DRIVER) {
      return mk("merge-driver", STATUS.ok, "coc-ledger merge driver registered (canonical)");
    }
    return mk(
      "merge-driver",
      STATUS.warn,
      `coc-ledger merge driver registered but non-canonical: \`${drv.stdout.trim()}\``,
      "run `loom doctor --fix` to re-register the canonical `node`-prefixed command; a bare " +
        "(non-`node`) path fails `Permission denied` under git's shell exec and silently falls " +
        "back to the default line-merge, clobbering .session-notes.shared.md rows (loom#741)",
    );
  }
  return mk(
    "merge-driver",
    STATUS.warn,
    ".gitattributes uses merge=coc-ledger but the driver is not registered in git config",
    "run `loom doctor --fix` to register merge.coc-ledger.{name,driver}; without it, " +
      ".session-notes.shared.md 3-way merges fall back to the default driver and clobber rows",
  );
}

// ── the pre-push TRIGGER ─────────────────────────────────────────────────────
//
// WHY THIS CHECK EXISTS, and what it deliberately does NOT do.
//
// On a trunk with no CI the `pre-push` hook is the only gate that exists — the
// shipped shim says so in its own body. Its LOGIC is tracked at
// `scripts/ci/dev-push-guard.mjs`; its TRIGGER is not, and CANNOT be: git
// refuses every path inside `.git/`. MEASURED, `git add --dry-run
// .git/hooks/pre-push` → rc=128 `pathspec did not match any files`, against a
// control on a normal path at rc=0. So the trigger is provisioned per-clone by
// hand, and a clone that never provisioned it is COMPLETELY UNGATED while every
// file the guard needs sits right there. That is `artifact-stranding.md` MUST-3
// at the highest-consequence gate in the repo, and it is unfixable in the
// direction that rule normally points — the content can move, the trigger
// cannot.
//
// This check does not fix it. It DETECTS it. Detectability is the whole
// deliverable: the sibling adapter lane's argument — recorded and accepted in
// `journal/0619` — is that pointing `core.hooksPath` at a tracked directory
// removes CONTENT drift but not the PROVISIONING step, so adoption is a partial
// fix that reads as a complete one. A detector only reads, and cannot disarm
// anything.
//
// THREE STATES, AND UNKNOWN IS NEVER FOLDED (`instrument-discipline.md`
// MUST-1). A check that cannot determine its subject's state has verified
// NOTHING, and "cannot determine" must never be rendered as a pass or as a
// failure. `unknown` is therefore a first-class verdict here, not an error path.
//
// A FOURTH OUTCOME IS NOT ONE OF THE THREE, and the distinction is load-bearing
// because THIS FILE SHIPS. `loom-doctor.mjs` is `always_include` in
// `sync-tier-aware.mjs`, so this code runs at every USE template, every BUILD
// repo and every downstream consumer — none of which holds
// `scripts/ci/dev-push-guard.mjs`. There, the question does not apply, and
// `n/a` is a POSITIVE measured fact (the delegate is absent from disk), NOT an
// UNKNOWN. Reporting `ok` there would be a false clean; `crit` would be a false
// alarm on a repo that never had this gate.
const PUSH_GUARD_DELEGATE_REL = "scripts/ci/dev-push-guard.mjs";
const PUSH_GUARD_TRACKED_TRIGGER_REL = ".githooks/pre-push";
const PUSH_GUARD_ACTIVATION = "git config core.hooksPath .githooks";

/**
 * PURE. State descriptor → verdict. No I/O, so the fixtures can drive every
 * branch from a JSON descriptor and the answer key can live in a separate file.
 *
 * @param {object} s
 * @param {boolean} s.delegatePresent      is the tracked guard on disk?
 * @param {string|null} s.hooksDir         resolved active hooks dir, or null
 * @param {string|null} s.resolveError     why the dir could not be resolved
 * @param {string|null} s.readError        why the dir/file could not be read
 * @param {boolean} s.triggerPresent       is there a `pre-push` in that dir?
 * @param {boolean} s.triggerExecutable    does it carry an executable bit?
 * @param {boolean} s.triggerDelegates     does its content name the delegate?
 * @param {boolean} s.trackedTriggerPresent is `.githooks/pre-push` on disk?
 * @returns {{state:string, code:string, detail:string, remediation:string|null}}
 */
export function classifyPushGuardTrigger(s) {
  const state = s || {};

  // (0) APPLICABILITY, decided first and on a POSITIVE fact. Asked before
  // resolution deliberately: at a consumer the hooks dir resolves perfectly
  // well, so an unknown-first ordering would report UNKNOWN on a repo where the
  // question is simply absent.
  // delegateReadError gates this arm: absent-from-disk and could-not-look are
  // DIFFERENT answers, and only the first makes the question inapplicable.
  if (state.delegateReadError) {
    return {
      state: "unknown",
      code: "push-guard-trigger#unknown-delegate-unreadable",
      detail:
        "UNKNOWN (this is NOT a pass): " + PUSH_GUARD_DELEGATE_REL + " could not be read -- " +
        state.delegateReadError +
        ". Whether this clone has a push guard to trigger is UNDETERMINED; this is NOT the " +
        "n/a verdict, which asserts the delegate is absent from disk.",
      remediation: "fix the permissions on " + PUSH_GUARD_DELEGATE_REL + ", then re-run",
    };
  }
  if (!state.delegatePresent) {
    return {
      state: "n/a",
      code: "push-guard-trigger#not-applicable",
      detail: `no ${PUSH_GUARD_DELEGATE_REL} in this clone — no push guard to trigger`,
      remediation: null,
    };
  }

  // (1) UNKNOWN — the instrument could not see its subject. Both arms report
  // the reason, because "unknown" with no cause is indistinguishable from a
  // check that was never written.
  if (state.resolveError || !state.hooksDir) {
    return {
      state: "unknown",
      code: "push-guard-trigger#unknown-hooks-dir-unresolved",
      detail:
        "UNKNOWN (this is NOT a pass): could not resolve the active hooks directory — " +
        (state.resolveError || "no path returned"),
      remediation:
        "resolve it by hand (`git rev-parse --git-common-dir`, `git config --get core.hooksPath`) " +
        "and re-run; until then the trunk gate's state is undetermined",
    };
  }
  if (state.readError) {
    return {
      state: "unknown",
      code: "push-guard-trigger#unknown-hooks-dir-unreadable",
      detail: `UNKNOWN (this is NOT a pass): ${state.hooksDir} could not be read — ${state.readError}`,
      remediation: "fix the permissions on the hooks directory, then re-run",
    };
  }

  // (2) ABSENT — three distinct ways, each its own identity, because the
  // remediation differs and a single "absent" would send the reader to the
  // wrong one. Every arm is `crit`: on a CI-less trunk each means unguarded.
  if (!state.triggerPresent) {
    return {
      state: "absent",
      code: "push-guard-trigger#absent-no-hook",
      detail: `no pre-push hook in ${state.hooksDir} — the trunk gate is NOT installed in this clone`,
      remediation: state.trackedTriggerPresent
        ? `the tracked trigger exists at ${PUSH_GUARD_TRACKED_TRIGGER_REL}; activate it with \`${PUSH_GUARD_ACTIVATION}\` ` +
          "(READ FIRST: that redirect makes git ignore .git/hooks entirely — measured — so any hook already " +
          "installed there stops firing)"
        : `author one, or copy ${PUSH_GUARD_TRACKED_TRIGGER_REL} from a clone that has it`,
    };
  }
  if (!state.triggerExecutable) {
    return {
      state: "absent",
      code: "push-guard-trigger#absent-not-executable",
      detail:
        `a pre-push hook exists in ${state.hooksDir} but carries no executable bit — git IGNORES it ` +
        "and the push proceeds (MEASURED: git emits a `hint:`, not an error, and the operation lands)",
      remediation: "chmod +x the hook; a non-executable hook fails OPEN, which is indistinguishable from having none",
    };
  }
  if (!state.triggerDelegates) {
    return {
      state: "absent",
      code: "push-guard-trigger#absent-does-not-delegate",
      detail:
        `the pre-push hook in ${state.hooksDir} does not reference ${PUSH_GUARD_DELEGATE_REL} — ` +
        "it is some OTHER hook, so the tracked guard never runs",
      remediation:
        `point it at ${PUSH_GUARD_DELEGATE_REL} (or replace it with ${PUSH_GUARD_TRACKED_TRIGGER_REL}); ` +
        "whatever it currently does, it is not this gate",
    };
  }

  // (3) INSTALLED. Bounded claim: the hook is present, executable, and names
  // the delegate. That it BEHAVES correctly is not asserted — this is a content
  // match, not an execution.
  return {
    state: "installed",
    code: "push-guard-trigger#installed",
    // "references", never "delegating": the predicate is body.includes(...), a
    // CONTENT match. An operator who inserts an early exit after the shebang leaves
    // the string intact, so "delegating" would report a control-flow relationship
    // the check never established -- ARMED is not PROVEN EFFECTIVE, in the one
    // string an operator actually reads. (Security review 2026-09-20, F2.)
    detail:
      "pre-push installed in " + state.hooksDir + " and REFERENCES " + PUSH_GUARD_DELEGATE_REL +
      " (content match only -- that it EXECUTES the guard is not asserted)",
    remediation: null,
  };
}

/** Impure: gather the descriptor `classifyPushGuardTrigger` consumes. */
function gatherPushGuardTriggerState(exec, readFile, statFile) {
  // PRESENCE is only false when the read returned a real ENOENT. A read that
  // FAILED leaves presence UNKNOWN, carried separately so arm (0) cannot report
  // n/a about a delegate it could not look at.
  const delegateRead = readOutcome(readFile, path.join(REPO_ROOT, PUSH_GUARD_DELEGATE_REL));
  const delegatePresent = delegateRead.text !== null;
  const delegateReadError = delegateRead.error;
  const trackedRead = readOutcome(readFile, path.join(REPO_ROOT, PUSH_GUARD_TRACKED_TRIGGER_REL));
  const trackedTriggerPresent = trackedRead.text !== null;

  // Resolve the ACTIVE hooks directory the way git does, rather than testing
  // for absence. `core.hooksPath` at loom is explicitly SET to the default
  // location — measured — so an "is it unset?" predicate would answer a
  // different question and would be wrong after one `git config` edit.
  let hooksDir = null;
  let resolveError = null;
  const cfg = exec("git", ["config", "--get", "core.hooksPath"]);
  if (cfg.ok && cfg.stdout && cfg.stdout.trim()) {
    const raw = cfg.stdout.trim();
    // git resolves a relative hooksPath against the top level of the working
    // tree; an absolute one is taken as-is.
    hooksDir = path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  } else {
    const common = exec("git", ["rev-parse", "--git-common-dir"]);
    if (common.ok && common.stdout && common.stdout.trim()) {
      const raw = common.stdout.trim();
      hooksDir = path.join(path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw), "hooks");
    } else {
      // NOT folded into "absent": a git that cannot name its own common dir
      // tells us nothing about whether a hook is installed.
      resolveError = common.error || "`git rev-parse --git-common-dir` returned nothing";
    }
  }

  let triggerPresent = false;
  let triggerExecutable = false;
  let triggerDelegates = false;
  let readError = null;
  if (hooksDir) {
    const st = statFile(path.join(hooksDir, "pre-push"));
    if (st && st.error) {
      readError = st.error;
    } else if (st && st.exists) {
      triggerPresent = true;
      triggerExecutable = st.executable === true;
      const bodyRead = readOutcome(readFile, path.join(hooksDir, "pre-push"));
      if (bodyRead.error) {
        // The hook EXISTS and is executable; we simply cannot read it. Reporting
        // does-not-delegate here would diagnose a file never read.
        readError = readError || ("pre-push unreadable -- " + bodyRead.error);
      }
      triggerDelegates = typeof bodyRead.text === "string" && bodyRead.text.includes("dev-push-guard.mjs");
    }
  }

  return {
    delegatePresent,
    delegateReadError,
    trackedTriggerPresent,
    hooksDir,
    resolveError,
    readError,
    triggerPresent,
    triggerExecutable,
    triggerDelegates,
  };
}

/**
 * PURE: trigger state → doctor status. ONE mapping, exported, so the fixtures
 * pin the same table the report renders. A second copy written at the fixture
 * would be free to drift from this one, and the looser of the two would decide
 * — the shape `security.md` § Multi-Site Kwarg Plumbing forbids.
 *
 * `unknown` → `warn`, deliberately, and it is the only judgment call here:
 * `crit` would assert a FAILURE the check did not observe, while `ok` would
 * assert a PASS it also did not observe. `warn` carries the loudness without
 * claiming either, and the detail string says "this is NOT a pass" in words.
 */
export function pushGuardTriggerStatus(state) {
  if (state === "installed") return STATUS.ok;
  if (state === "absent") return STATUS.crit;
  if (state === "unknown") return STATUS.warn;
  if (state === "n/a") return STATUS.info;
  // Fail CLOSED on an unrecognised state rather than defaulting to `ok`: a new
  // state added to the classifier without a row here must be LOUD, not clean.
  return STATUS.warn;
}

function checkPushGuardTrigger(exec, readFile, statFile) {
  const verdict = classifyPushGuardTrigger(gatherPushGuardTriggerState(exec, readFile, statFile));
  const status = pushGuardTriggerStatus(verdict.state);
  return mk("push-guard-trigger", status, verdict.detail, verdict.remediation, {
    trigger_state: verdict.state,
    code: verdict.code,
  });
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

// ADO org/project readiness — config-presence ONLY, never a live Graph probe
// (the live-API existence-check is the ceremony's job per
// verify-resource-existence.md MUST-2). Detect ADO targeting via the same signal
// the ceremony uses (roster.genesis.provider === "azure-devops"), else infer it
// when `az` is the ONLY authenticated host. On a non-ADO clone this returns
// `info`/skip so a GitHub-only clone never sees ADO noise.
function checkAdoReadiness(exec, readFile, ghCheck, azCheck) {
  // ── Is this clone ADO-targeted? ──────────────────────────────────────────
  // Signal 1 (authoritative): the roster genesis provider, when a roster exists.
  // A parseable roster is authoritative in BOTH directions — `provider` absent or
  // "github" means GitHub genesis (the schema's backward-compatible default), which
  // MUST suppress the Signal-2 inference so a GitHub clone never sees ADO noise even
  // when `gh` auth has lapsed while `az` happens to be authed.
  let adoTargeted = false;
  let rosterSaysNonAzure = false;
  let rosterProject = null;
  let rosterOwner = null;
  const rosterRaw = readFile(path.join(REPO_ROOT, ".claude", "operators.roster.json"));
  if (rosterRaw) {
    try {
      const g = JSON.parse(rosterRaw)?.genesis || {};
      if (g.provider === "azure-devops") {
        adoTargeted = true;
        rosterProject = g.ado_project || null;
        rosterOwner = g.repo_owner || null;
      } else {
        // present + parseable + provider github/absent ⇒ authoritatively non-Azure
        rosterSaysNonAzure = true;
      }
    } catch {
      // malformed roster: no authoritative signal → inference still allowed
    }
  }
  // Signal 2 (inference): ONLY when no usable roster signal exists AND `az` is the
  // ONLY authed host. A roster that authoritatively names a non-Azure provider
  // suppresses it (the asymmetry the HIGH finding closed).
  if (!adoTargeted && !rosterSaysNonAzure && azCheck.authed && !ghCheck.authed) {
    adoTargeted = true;
  }

  if (!adoTargeted) {
    return mk(
      "ado-readiness",
      STATUS.info,
      "clone does not target Azure DevOps — skipping ADO org/project readiness",
      null,
    );
  }

  // ── ADO-targeted: is org+project resolvable? ─────────────────────────────
  // The roster's repo_owner + ado_project satisfy readiness without shelling out.
  if (rosterProject && rosterOwner) {
    return mk(
      "ado-readiness",
      STATUS.ok,
      `ADO org/project from roster genesis: ${rosterOwner}/${rosterProject}`,
    );
  }

  // No roster org+project → fall back to the `az devops` CLI defaults.
  const ext = exec("az", ["extension", "show", "--name", "azure-devops"]);
  if (ext.missing || !ext.ok) {
    return mk(
      "ado-readiness",
      STATUS.warn,
      "the `az devops` extension is not installed",
      "run `az extension add --name azure-devops`, then " +
        "`az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`",
    );
  }
  const cfg = exec("az", ["devops", "configure", "--list"]);
  if (!cfg.ok && !cfg.missing) {
    // The command errored (e.g. a broken extension state) — do NOT conflate that
    // with "unconfigured". Name the real cause so the remediation targets it.
    return mk(
      "ado-readiness",
      STATUS.warn,
      "could not read `az devops configure --list` (the command errored)",
      "check the `az devops` extension state (`az extension show --name azure-devops`); " +
        "reinstall with `az extension add --upgrade --name azure-devops` if it is broken",
    );
  }
  const cfgOut = cfg.ok ? cfg.stdout : "";
  const hasOrg = /(^|\n)\s*organization\s*=\s*\S/.test(cfgOut);
  const hasProject = /(^|\n)\s*project\s*=\s*\S/.test(cfgOut);
  if (hasOrg && hasProject) {
    return mk("ado-readiness", STATUS.ok, "az devops default organization + project configured");
  }
  const missing = [!hasOrg && "organization", !hasProject && "project"].filter(Boolean).join(" + ");
  return mk(
    "ado-readiness",
    STATUS.warn,
    `az devops default ${missing} not configured`,
    "run `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>` " +
      "so a genesis ceremony resolves the org/project before it fails on a cryptic ado_api_* capture",
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

// ════════════════════════════════════════════════════════════════════════════
//  Gate-2 target protection — OPT-IN (`--targets`), read-only, report-only
// ════════════════════════════════════════════════════════════════════════════
//
//  THE QUESTION. For each Gate-2 distribution target (the `build.*` /
//  `use-template.*` entries in the ecosystem config's `remote_links`): does its
//  DEFAULT branch carry at least one REQUIRED status check, and is
//  `enforce_admins` on? A target with no required check can never reach "CI
//  green" — `gh pr checks` reports no checks — so every merge into it is
//  unverified BY CONSTRUCTION, not merely unverified today. A target WITH
//  required checks but `enforce_admins` off is bypassable by any admin merge,
//  which is the path `gh pr merge --admin` takes.
//
//  ── WHAT THIS PRINTS (instrument-discipline.md MUST-1: the falsifying result
//     is NAMED, both poles, before any result is read as evidence) ───────────
//
//  PROPERLY PROTECTED (≥1 required context AND enforce_admins on) →
//    ✓ [OK] gate2-target:use-template.py: <org>/<repo>@main — 2 required
//           check(s): CI, Required checks; enforce_admins=on
//    …status `ok`, contributes 0 to summary.crit.
//
//  NOT PROTECTED (this is what F76 asserts is the fleet-wide state) →
//    ✗ [CRIT] gate2-target:use-template.py: <org>/<repo>@main — NO required
//             status check (no-branch-protection); enforce_admins=off
//    …status `crit`, so `--strict` / `--json` exits 1. Four DISTINCT reasons
//    are kept apart here and never collapsed, because each has a different
//    remedy at the target: `no-branch-protection` (nothing configured),
//    `required-status-checks-absent` (protection exists, no status-check rule),
//    `required-status-checks-null`, `required-status-checks-empty` (rule
//    exists, zero contexts).
//
//  PROTECTED BUT BYPASSABLE (≥1 required context, enforce_admins off) →
//    ! [WARN] gate2-target:…: … — 1 required check(s): CI; enforce_admins=OFF
//             (an admin merge bypasses every required check)
//
//  UNKNOWN (fail-closed; evidence-first-claims.md MUST-3 — an errored or empty
//  command is ZERO evidence, never confirmation) →
//    ✗ [CRIT] gate2-target:…: … — protection UNKNOWN (protection-probe-errored):
//             <first line of the gh failure>
//    …status `crit`, the SAME severity as unprotected. An unanswered probe
//    NEVER reports "protected", and never sits quieter than a real finding.
//
//  ── WHY `hasOwnKey` AND NOT `p?.required_status_checks?.contexts?.length` ──
//  GitHub OMITS `required_status_checks` entirely for one repo state and
//  returns it `null` for another. The optional-chain form collapses ABSENT,
//  PRESENT-AND-NULL and PRESENT-AND-EMPTY to one falsy value, so it prints the
//  same thing whether the proposition under test is true or false — a
//  non-discriminating instrument, worthless for this question. The key-presence
//  test keeps the three states apart and gives each its own `reason`.
//
//  ── SSOT ──────────────────────────────────────────────────────────────────
//  The required-status-check classifier is NOT re-implemented here. It is the
//  SAME exported `classifyTargetVerifiability` the Gate-2 driver refuses on,
//  pinned by the bipolar suite at audit-fixtures/gate2-target-verifiability/
//  (count NOT restated here — it moved 19 -> 94 while this line still said 19;
//  read it from the runner's control / ci-audit-fixtures.json).
//  Two independent copies of a fail-closed classifier is the drift class
//  security.md § Enforcement-Surface Parity exists to prevent. Only the
//  `enforce_admins` dimension — which the driver does not classify — is new.
//
//  ── REPORT-ONLY ───────────────────────────────────────────────────────────
//  This NEVER writes to any other repo. loom does not own a target's branch
//  protection and MUST NOT edit it (repo-scope-discipline.md); the target's
//  owner remediates. It is also NOT part of the default run: every other check
//  is local, and a default-surfaced command must not fan out N cross-repo API
//  calls on an unattended invocation. `--targets` is the explicit opt-in.

/**
 * Present-and-own-key test. Mirrors `hasKey` in sync-gate2-worktree.mjs, which
 * is module-private there. A one-line predicate is copied; the CLASSIFIER is
 * not (see § SSOT above).
 */
function hasOwnKey(o, k) {
  return Boolean(o) && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * First non-empty line of a captured failure, for a one-line `detail`.
 *
 * The text is REMOTE-INFLUENCED — it is `gh`'s rendering of a GitHub API
 * response, so a repo name, branch name or error message an attacker controls
 * reaches this terminal. Control bytes are escaped before the string is ever
 * written out: an unescaped CSI sequence in a health report is a terminal
 * injection dressed as a diagnostic. This is the only surface in loom-doctor
 * that carries text from off this machine, which is why the escape lives here
 * rather than at each print site.
 */
function firstLine(text) {
  const line =
    String(text || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0] || "";
  return escapeControlBytes(line);
}

/** Render C0/C1 control bytes as `\xNN` so nothing reaches the terminal raw. */
function escapeControlBytes(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
    `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * Enumerate the Gate-2 distribution targets from an ecosystem config OBJECT.
 * Pure. `build.<t>` / `use-template.<t>` are the resolver-key namespaces the
 * Gate-2 driver derives from `--lane build|use` (sync-gate2-worktree.mjs), so
 * this reads the SAME declaration rather than hardcoding a target list.
 * Non-target links (`loom`, `atelier`, `command`) are excluded: they are not
 * distribution destinations.
 * @returns {{key:string, slug:string}[]} sorted by key; [] when unconfigured.
 */
export function enumerateGate2Targets(config) {
  const links = config && config.remote_links;
  if (!links || typeof links !== "object") return [];
  const out = [];
  for (const key of Object.keys(links).sort()) {
    if (!/^(?:build|use-template)\./.test(key)) continue;
    const e = links[key];
    if (!e || typeof e !== "object" || !e.org || !e.repo) continue;
    out.push({ key, slug: `${e.org}/${e.repo}` });
  }
  return out;
}

/**
 * This repo's OWN `origin` slug, from the operator's actual git remote — never a
 * hardcoded path (`repo-scope-discipline.md`: resolve from the declared binding).
 * Local `git` only; no network. Returns null when origin is absent/unparseable,
 * which the caller treats as "no self entry in the allowlist", never as a match.
 */
export function ownOriginSlug(exec) {
  // HELPERED ON BOTH HALVES (loom#1471). This comment previously claimed the
  // call was "HELPERED, not ambient" while only the BINARY half had been
  // applied — the env half was missing, so the call still inherited the ambient
  // environment. The claim is corrected rather than left standing, because the
  // harm it names is reached by BOTH routes:
  //
  //   * PATH route (closed here, by `resolveGitBinary()`): a planted `git`
  //     earlier on PATH answers with a fabricated origin.
  //   * ENV route (closed in `defaultExec`'s envelope, NOT here): an ambient
  //     `GIT_DIR` outranks repository discovery, so a real git answers about an
  //     ATTACKER'S repository. `-C` and `cwd:` do not shut this — both choose a
  //     DIRECTORY, never a REPOSITORY.
  //
  // Either way the fabricated value feeds an ALLOWLIST, minting a self entry
  // that was never authorized. `resolveGitBinary()` stays called HERE as well as
  // in the envelope, because its null return is this function's fail-closed
  // signal (below) and not merely a binary lookup.
  //
  // Fail-CLOSED to null rather than throwing, which is this function's OWN
  // documented contract ("the caller treats [null] as 'no self entry in the
  // allowlist', never as a match"). For an allowlist, no-entry is the safe
  // direction; throwing would take down a health-check whose job is to report.
  const gitBin = _gitSubprocessEnv ? _gitSubprocessEnv.resolveGitBinary() : null;
  if (!gitBin) return null;
  const r = exec(gitBin, ["remote", "get-url", "origin"]);
  if (r.missing || !r.ok) return null;
  const url = (r.stdout || "").trim();
  // git@host:owner/repo(.git)  |  https://host/owner/repo(.git)  |  ssh://host/owner/repo
  const m =
    url.match(/^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/) ||
    url.match(/^[a-z+]+:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a `--target-repo` argument to a probe target. PURE (the caller injects
 * `ownSlug`), and FAIL-CLOSED: an unrecognized value is REFUSED before any
 * network call is made.
 *
 * ── WHY THIS IS AN ALLOWLIST AND NOT A FREE-FORM SLUG ─────────────────────
 * A flag that accepted any `owner/repo` would be an arbitrary cross-repo READ
 * affordance, and it would sit OUTSIDE the `/cross-repo-authorize` ceremony —
 * an escape hatch that also escapes the authorization it exists under, which is
 * a worse defect than the gap it closes (`repo-scope-discipline.md`).
 *
 * So the accepted set is exactly: the Gate-2 targets `--targets` ALREADY probes
 * (by resolver key OR by slug), plus THIS repo's own `origin` — which is not a
 * cross-repo read at all. The flag therefore grants **zero** reach beyond the
 * enumeration it narrows; it selects from that set, it does not widen it. Note
 * the allowlist is the ENUMERATED targets (`build.*` / `use-template.*`), NOT
 * every `remote_links` entry: admitting `loom`/`atelier`/`command` would reach
 * repos `--targets` does not, which is exactly the widening this forbids.
 *
 * @returns {{ok:true,key:string,slug:string}|{ok:false,reason:string,detail:string}}
 */
export function resolveTargetRepoArg(arg, config, ownSlug) {
  const want = String(arg || "").trim();
  if (want === "")
    return { ok: false, reason: "target-repo-empty", detail: "--target-repo needs a value" };

  const targets = enumerateGate2Targets(config);
  const byKey = targets.find((t) => t.key === want);
  if (byKey) return { ok: true, key: byKey.key, slug: byKey.slug };
  const bySlug = targets.find((t) => t.slug === want);
  if (bySlug) return { ok: true, key: bySlug.key, slug: bySlug.slug };
  if (ownSlug && want === ownSlug) return { ok: true, key: "self", slug: ownSlug };

  const allowed = [
    ...targets.map((t) => `${t.key} (${t.slug})`),
    ...(ownSlug ? [`self (${ownSlug})`] : []),
  ];
  return {
    ok: false,
    reason: "target-repo-not-allowlisted",
    detail:
      `'${want}' is not a declared Gate-2 target and is not this repo's own origin. ` +
      `NO probe was issued. Allowed: ${allowed.join(", ") || "(none declared)"}`,
  };
}

/**
 * Validate a BASE REF before it is interpolated into an API path. PURE.
 *
 * ── WHY THE BASE NEEDS A FENCE TOO ────────────────────────────────────────
 * `resolveTargetRepoArg` allowlists the REPO half of
 * `repos/<slug>/branches/<base>/protection`. The BASE half was free-form, on the
 * one check that leaves this repo — un-allowlisted reach on exactly the axis the
 * repo fence was written to deny. Measured on the unfenced build:
 *
 *   --target-base "main/protection/../../../../evil/repo/branches/main"
 *   → gh api repos/<org>/<repo>/branches/main/protection/../../../../evil/repo/branches/main/protection
 *
 * ...and the row rendered `[OK]`. Whether a given `gh` build collapses `..`
 * client-side, sends it literally, or GitHub 404s it is NOT what makes this a
 * defect and is deliberately NOT relied on: rejecting a traversal segment in a
 * path component you interpolate is correct regardless of the client, and
 * settling the wire question needs a live request to a non-CWD repo.
 *
 * ── NOT A SLASH BAN ───────────────────────────────────────────────────────
 * Branch names legitimately contain `/` (`release/v1.2.3`), so a blanket ban
 * would be the wrong fix. The rule set below is git's own `check-ref-format`
 * grammar, which excludes every traversal and smuggling form while admitting
 * every name git itself would accept — plus TWO deliberate additions, `%` and `#`.
 *
 * Both are LEGAL in a git ref and illegal here, because this string does not stay
 * a ref: it becomes part of a URL. `%` is the percent-encoding smuggling vector —
 * `%2e%2e` is a `..` that survives a literal-string check and becomes a traversal
 * only after the SERVER decodes it. `#` is the fragment delimiter: everything
 * after it is cut client-side, so `main#...` silently retargets the request.
 * Refusing both costs a vanishingly rare branch name and is loud when it fires,
 * which is the right trade on the one check that leaves this repo. `#` was added
 * because the fixture caught it: the first fence passed every other hostile form
 * and let `main#frag` through.
 *
 * @returns {{ok:true}|{ok:false,reason:string,detail:string}}
 */
export function validateBaseRef(base) {
  const b = typeof base === "string" ? base : "";
  if (b === "") return { ok: false, reason: "base-ref-empty", detail: "base ref must be a non-empty string" };

  // git check-ref-format: no ASCII control, space, ~ ^ : ? * [ \ — plus % (above).
  // eslint-disable-next-line no-control-regex
  const forbidden = b.match(/[\u0000-\u0020\u007f~^:?*[\\%#]/);
  if (forbidden)
    return {
      ok: false,
      reason: "base-ref-forbidden-character",
      detail: `character ${JSON.stringify(forbidden[0])} is not allowed in a base ref`,
    };
  if (b.startsWith("/") || b.endsWith("/") || b.includes("//"))
    return { ok: false, reason: "base-ref-bad-slash", detail: "a ref cannot start/end with '/' or contain '//'" };
  // The traversal check proper. Segment-wise, so a branch legitimately named
  // `v1..2` is caught too (git forbids `..` anywhere) and `foo..bar` cannot slip
  // through a segment-only reading.
  if (b.includes("..") || b.split("/").some((s) => s === "." || s === ".."))
    return { ok: false, reason: "base-ref-path-traversal", detail: "'..' is not allowed in a base ref" };
  if (b.endsWith(".") || b.endsWith(".lock") || b.includes("@{") || b === "@")
    return { ok: false, reason: "base-ref-malformed", detail: "ref ends with '.'/'.lock', or is '@'/contains '@{'" };
  return { ok: true };
}

/** A REFUSED base ref, rendered in the same crit shape as a refused --target-repo. */
export function baseRefRefusalRow(refusal, base) {
  return mk(
    "gate2-targets",
    STATUS.crit,
    `--target-base REFUSED (${refusal.reason}): ${refusal.detail} — received ${JSON.stringify(String(base))}. NO probe was issued.`,
    "pass a plain branch name (slashes are fine: `release/v1.2.3`). The base is interpolated " +
      "into the API path, so a traversal or smuggling form is refused before any request — " +
      "the same fence --target-repo applies to the repo half",
    { target_count: 0, probed: false },
  );
}

/**
 * Probe a repo's DEFAULT branch name. Fails CLOSED: any non-success is an
 * error the caller MUST render as UNKNOWN, never as a branch guess.
 * @returns {{status:"ok",branch:string}|{status:"error",detail:string}}
 */
export function probeDefaultBranch(exec, repoSlug) {
  const r = exec("gh", ["api", `repos/${repoSlug}`, "--jq", ".default_branch"]);
  if (r.missing) return { status: "error", detail: "gh is not installed" };
  if (!r.ok) {
    const text = `${r.stderr || ""}\n${r.stdout || ""}\n${r.error || ""}`;
    return { status: "error", detail: firstLine(text) || `gh api exited ${r.code}` };
  }
  const branch = (r.stdout || "").trim();
  if (!branch) return { status: "error", detail: "gh api returned an empty default_branch" };
  return { status: "ok", branch };
}

/**
 * Probe branch protection. STRICTER than the Gate-2 driver's probe on ONE axis,
 * deliberately: a bare HTTP 404 is NOT read as "unprotected".
 *
 * GitHub returns 404 with the body `Branch not protected` when the branch
 * genuinely has no protection — a DETERMINATE answer. It ALSO returns a bare
 * 404 / `Not Found` when the repo or branch does not exist, or exists but is
 * invisible to this token. Those two are opposite facts behind the same status
 * code, so only the explicit `Branch not protected` body is taken as
 * determinate; a bare 404 classifies UNKNOWN (evidence-first-claims.md MUST-3
 * — a permission denial is not an all-clear). The Gate-2 driver's own probe is
 * left untouched: its verdict semantics gate an exit-6 merge refusal and are
 * pinned by their own fixtures.
 *
 * @returns {{status:"ok",protection:object}|{status:"not-found",protection:null}
 *          |{status:"error",protection:null,detail:string}}
 */
export function probeTargetProtectionStrict(exec, repoSlug, base) {
  // Enforced AT THE SINK — the place that builds the path — so no caller can
  // bypass it, including a future one and the API-derived branch name from
  // probeDefaultBranch. `runTargetChecks` ALSO validates at the flag boundary
  // for a cleaner operator message; both route through the ONE helper rather
  // than carrying separate copies (`security.md` § Enforcement-Surface Parity).
  const okBase = validateBaseRef(base);
  if (!okBase.ok)
    return {
      status: "error",
      protection: null,
      detail: `refusing to probe: base ref rejected (${okBase.reason}) — ${okBase.detail}`,
    };
  const r = exec("gh", ["api", `repos/${repoSlug}/branches/${base}/protection`]);
  if (r.missing)
    return {
      status: "error",
      protection: null,
      detail: "gh is not installed — protection is UNKNOWN, not absent",
    };
  if (!r.ok) {
    const text = `${r.stderr || ""}\n${r.stdout || ""}\n${r.error || ""}`;
    if (/Branch not protected/i.test(text)) return { status: "not-found", protection: null };
    if (/HTTP 404|Not Found/i.test(text))
      return {
        status: "error",
        protection: null,
        detail:
          "HTTP 404 with no 'Branch not protected' body — the repo/branch is absent OR " +
          "invisible to this token; NOT readable as 'unprotected'",
      };
    return {
      status: "error",
      protection: null,
      detail: firstLine(text) || `gh api exited ${r.code}`,
    };
  }
  try {
    return { status: "ok", protection: JSON.parse(r.stdout || "") };
  } catch (e) {
    return { status: "error", protection: null, detail: `unparseable gh api JSON: ${e.message}` };
  }
}

/**
 * Classify `enforce_admins` from a protection probe result. Pure.
 *
 * Key-presence tested, never optional-chained: an ABSENT `enforce_admins` is
 * NOT evidence it is off, so it classifies `unknown`. `on` is returned ONLY
 * from an observed boolean `true`.
 *
 * @returns {{verdict:"on"|"off"|"unknown", reason:string, detail?:string}}
 */
export function classifyEnforceAdmins(probe) {
  const status = probe && probe.status;
  // No protection at all ⇒ there is nothing enforcing anything on admins.
  if (status === "not-found") return { verdict: "off", reason: "no-branch-protection" };
  if (status === "error")
    return {
      verdict: "unknown",
      reason: "protection-probe-errored",
      detail: (probe && probe.detail) || "",
    };
  if (status !== "ok")
    return {
      verdict: "unknown",
      reason: "protection-probe-unclassified",
      detail: `unrecognized probe status ${JSON.stringify(status)}`,
    };

  const p = probe.protection;
  if (!p || typeof p !== "object")
    return {
      verdict: "unknown",
      reason: "protection-payload-not-an-object",
      detail: `payload typeof ${typeof p}`,
    };
  if (!hasOwnKey(p, "enforce_admins"))
    return { verdict: "unknown", reason: "enforce-admins-key-absent" };

  const ea = p.enforce_admins;
  if (ea === null) return { verdict: "unknown", reason: "enforce-admins-null" };
  if (typeof ea === "boolean")
    return { verdict: ea ? "on" : "off", reason: "enforce-admins-boolean" };
  if (typeof ea === "object" && hasOwnKey(ea, "enabled")) {
    if (typeof ea.enabled !== "boolean")
      return {
        verdict: "unknown",
        reason: "enforce-admins-enabled-not-a-boolean",
        detail: `enabled typeof ${typeof ea.enabled}`,
      };
    return { verdict: ea.enabled ? "on" : "off", reason: "enforce-admins-enabled" };
  }
  return {
    verdict: "unknown",
    reason: "enforce-admins-unrecognized-shape",
    detail: `enforce_admins typeof ${typeof ea}`,
  };
}

const REMEDIATE_UNPROTECTED =
  "the TARGET's owner must add ≥1 required status check on this branch (Settings → " +
  "Branches → protection rule → Require status checks to pass) and enable " +
  "'Do not allow bypassing the above settings'; loom does NOT own this target's branch " +
  "protection and MUST NOT edit it (repo-scope-discipline.md) — this tool only reports";
const REMEDIATE_UNKNOWN =
  "re-run the probe once the cause above is cleared (gh auth / network / repo visibility). " +
  "UNKNOWN is ZERO evidence, NOT an all-clear (evidence-first-claims.md MUST-3) — it is " +
  "reported at the same severity as unprotected on purpose";

/**
 * Fold a checks-verdict + an admins-verdict into one doctor check row. Pure, so
 * the exact operator-visible wording is what the fixtures assert.
 *
 * Precedence is FAIL-CLOSED: any `unknown` on either dimension outranks every
 * determinate verdict, so an unanswered probe can never be reported as a pass.
 */
export function buildTargetCheck(targetKey, repoSlug, base, checks, admins) {
  const id = `gate2-target:${targetKey}`;
  const where = `${repoSlug}@${base}`;
  const extra = {
    target_key: targetKey,
    repo_slug: repoSlug,
    base,
    required_checks: { verdict: checks.verdict, reason: checks.reason, contexts: checks.contexts || [] },
    enforce_admins: { verdict: admins.verdict, reason: admins.reason },
  };

  if (checks.verdict === "unknown" || admins.verdict === "unknown") {
    const reason = checks.verdict === "unknown" ? checks.reason : admins.reason;
    const detail = checks.verdict === "unknown" ? checks.detail : admins.detail;
    return mk(
      id,
      STATUS.crit,
      `${where} — protection UNKNOWN (${reason})${detail ? `: ${detail}` : ""}`,
      REMEDIATE_UNKNOWN,
      extra,
    );
  }
  if (checks.verdict === "unverifiable") {
    return mk(
      id,
      STATUS.crit,
      `${where} — NO required status check (${checks.reason}); enforce_admins=${admins.verdict}. ` +
        `A PR into this target can never reach "CI green", so any merge here is ` +
        `UNVERIFIED BY CONSTRUCTION.`,
      REMEDIATE_UNPROTECTED,
      extra,
    );
  }
  // verifiable from here down
  const list = (checks.contexts || []).join(", ");
  const n = (checks.contexts || []).length;
  if (admins.verdict === "off") {
    return mk(
      id,
      STATUS.warn,
      `${where} — ${n} required check(s): ${list}; enforce_admins=OFF ` +
        `(an admin merge bypasses every required check above)`,
      "the TARGET's owner should enable 'Do not allow bypassing the above settings' " +
        "(enforce_admins); loom reports only and MUST NOT edit it (repo-scope-discipline.md)",
      extra,
    );
  }
  return mk(id, STATUS.ok, `${where} — ${n} required check(s): ${list}; enforce_admins=on`, null, extra);
}

/** Roll-up row so a fleet-level claim has one grep-stable carrier. */
export function buildTargetsSummary(rows) {
  const crit = rows.filter((r) => r.status === STATUS.crit).length;
  const warn = rows.filter((r) => r.status === STATUS.warn).length;
  const ok = rows.filter((r) => r.status === STATUS.ok).length;
  const detail =
    `${rows.length} Gate-2 target(s) probed — ${ok} protected, ${warn} bypassable ` +
    `(admin-merge), ${crit} unprotected-or-UNKNOWN`;
  if (crit > 0)
    return mk(
      "gate2-targets",
      STATUS.crit,
      detail,
      "each CRIT row above names its own reason and remedy; every one of them is a target " +
        "whose merges are unverified by construction or whose state could not be established",
    );
  if (warn > 0) return mk("gate2-targets", STATUS.warn, detail, "see the WARN rows above");
  return mk("gate2-targets", STATUS.ok, detail);
}

/**
 * Load the Gate-2 required-status-check classifier (the SSOT — see § SSOT).
 * The driver is fenced `loom_only`, so at a consumer clone the import fails;
 * that returns null and every target reports UNKNOWN (fail-closed), never a
 * locally re-derived verdict.
 */
async function loadVerifiabilityClassifier() {
  try {
    const m = await import("./sync-gate2-worktree.mjs");
    return typeof m.classifyTargetVerifiability === "function" ? m.classifyTargetVerifiability : null;
  } catch {
    return null;
  }
}

/**
 * Run the opt-in Gate-2 target-protection probes. Async + separate from
 * runDoctor() so the DEFAULT run stays 100% local: nothing here executes
 * unless `--targets` was passed.
 *
 * @returns {{checks:object[]}} [] when no Gate-2 targets are declared.
 */
export async function runTargetChecks(opts = {}) {
  const {
    exec = defaultExec,
    config = ecosystem.config,
    configError = ecosystem.error,
    base = null, // explicit override; null ⇒ probe each repo's default branch
    targetRepo = null, // narrow to ONE allowlisted target (see resolveTargetRepoArg)
    probeProtection = probeTargetProtectionStrict,
    probeBranch = probeDefaultBranch,
    classifyChecks = await loadVerifiabilityClassifier(),
  } = opts;

  if (configError) return { checks: [configErrorRow(configError)] };

  // An explicit --target-base is validated BEFORE anything else: a refusal must
  // cost zero API calls, exactly as an un-allowlisted --target-repo does. (A
  // null base means "resolve each repo's default branch"; that value is checked
  // at the sink, where it arrives from the API.)
  if (base !== null) {
    const okBase = validateBaseRef(base);
    if (!okBase.ok) return { checks: [baseRefRefusalRow(okBase, base)] };
  }

  let targets = enumerateGate2Targets(config);
  if (targetRepo !== null) {
    // Resolve BEFORE any probe: a refusal must cost zero network calls, so an
    // un-allowlisted value can never reach `gh` even once.
    const picked = resolveTargetRepoArg(targetRepo, config, ownOriginSlug(exec));
    if (!picked.ok) return { checks: [targetRepoRefusalRow(picked)] };
    targets = [{ key: picked.key, slug: picked.slug }];
  }
  if (targets.length === 0) return { checks: [] };

  const rows = [];
  for (const t of targets) {
    if (!classifyChecks) {
      rows.push(
        buildTargetCheck(
          t.key,
          t.slug,
          base || "?",
          {
            verdict: "unknown",
            reason: "verifiability-classifier-unavailable",
            detail: "sync-gate2-worktree.mjs did not load (fenced loom_only at this clone)",
          },
          { verdict: "unknown", reason: "verifiability-classifier-unavailable" },
        ),
      );
      continue;
    }
    let branch = base;
    if (!branch) {
      const b = probeBranch(exec, t.slug);
      if (b.status !== "ok") {
        rows.push(
          buildTargetCheck(
            t.key,
            t.slug,
            "?",
            { verdict: "unknown", reason: "default-branch-probe-errored", detail: b.detail },
            { verdict: "unknown", reason: "default-branch-probe-errored" },
          ),
        );
        continue;
      }
      branch = b.branch;
    }
    const probe = probeProtection(exec, t.slug, branch);
    rows.push(buildTargetCheck(t.key, t.slug, branch, classifyChecks(probe), classifyEnforceAdmins(probe)));
  }
  rows.push(buildTargetsSummary(rows));
  return { checks: rows };
}

/**
 * The NOT-PROBED row for a default run at a clone that HAS Gate-2 targets.
 * An unrun check reported as silence is indistinguishable from a clean one, so
 * the row is always emitted rather than omitted.
 */
export function notProbedRow(config = ecosystem.config, configError = ecosystem.error) {
  if (configError) return configErrorRow(configError);
  const targets = enumerateGate2Targets(config);
  if (targets.length === 0) return null;
  return mk(
    "gate2-targets",
    STATUS.info,
    `${targets.length} Gate-2 target(s) declared — branch protection NOT PROBED ` +
      `(this is the only check that leaves this repo)`,
    "run `loom doctor --targets` to probe each target's default branch for required " +
      "status checks + enforce_admins (read-only; N GitHub API calls)",
    { target_count: targets.length, probed: false },
  );
}

/**
 * A malformed ecosystem config cannot be reported as "0 Gate-2 targets" — that
 * is the same output an unconfigured consumer produces, so it would carry zero
 * information about which state this clone is in.
 */
/**
 * A REFUSED `--target-repo`. `crit`, so `--strict` exits non-zero: a refusal
 * that exited 0 would read like a clean probe of a repo never contacted.
 */
export function targetRepoRefusalRow(refusal) {
  return mk(
    "gate2-targets",
    STATUS.crit,
    `--target-repo REFUSED (${refusal.reason}): ${refusal.detail}`,
    "pass a declared Gate-2 target (resolver key or owner/repo slug) or this repo's own " +
      "origin. The flag NARROWS the enumeration; it cannot widen it, so it grants no reach " +
      "`--targets` does not already have and is not a route around /cross-repo-authorize",
    { target_count: 0, probed: false },
  );
}

export function configErrorRow(configError) {
  return mk(
    "gate2-targets",
    STATUS.crit,
    `Gate-2 targets could not be enumerated — the ecosystem config failed to load: ${configError}`,
    "fix .claude/bin/ecosystem.json; until it parses, target protection is UNKNOWN and " +
      "MUST NOT be read as either protected or absent",
    { target_count: null, probed: false },
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
    statFile = defaultStatFile,
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
    checkPushGuardTrigger(exec, readFile, statFile),
    gh,
    az,
    checkVcsHost(gh, az),
    checkAdoReadiness(exec, readFile, gh, az),
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

// COC_LEDGER_NAME + COC_LEDGER_DRIVER are imported from the coc-ledger-driver
// SSOT lib above (the `node `-prefix + %P-omission rationale lives there).

// Default seam: invoke the existing loom-links-init seeder (refuses-on-exists).
function defaultInvokeInit() {
  const init = path.join(SCRIPT_DIR, "loom-links-init.mjs");
  // The seeder is fenced `loom_only` at a consumer (F1030a); do NOT spawn a
  // missing script — report a skipped note so `--fix` degrades cleanly.
  if (!fs.existsSync(init)) {
    return {
      ok: false,
      detail: "loom-links-init.mjs not present at this clone; seed loom-links.local.json manually",
    };
  }
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
    // Use the real VALID_ROLES when loom-links loaded; else the local fallback
    // (F1030a — loom-links.mjs is the SSOT at loom, may be fenced at a consumer).
    const validRoles = loomLinks ? loomLinks.VALID_ROLES : VALID_ROLES_FALLBACK;
    if (!role) {
      manual.push(
        "role undeclared — re-run `loom doctor --fix --role <platform|build|use-consumer>` to ratify (no silent guess, D2)",
      );
    } else if (!validRoles.has(role)) {
      manual.push(`--role "${role}" is invalid — must be one of {${[...validRoles].join(", ")}}`);
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
  const flags = {
    help: false,
    json: false,
    fix: false,
    strict: false,
    role: null,
    targets: false,
    targetBase: null,
    targetRepo: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--fix") flags.fix = true;
    else if (a === "--strict") flags.strict = true;
    else if (a === "--targets") flags.targets = true;
    else if (a === "--role") flags.role = argv[++i] ?? null;
    else if (a.startsWith("--role=")) flags.role = a.slice("--role=".length);
    else if (a === "--target-base") flags.targetBase = argv[++i] ?? null;
    else if (a.startsWith("--target-base=")) flags.targetBase = a.slice("--target-base=".length);
    // --target-repo IMPLIES --targets: naming one target and having the probe
    // silently not run is the accepted-but-unused shape zero-tolerance Rule 3c
    // forbids at the CLI surface.
    else if (a === "--target-repo") {
      flags.targetRepo = argv[++i] ?? null;
      flags.targets = true;
    } else if (a.startsWith("--target-repo=")) {
      flags.targetRepo = a.slice("--target-repo=".length);
      flags.targets = true;
    }
  }
  return flags;
}

/**
 * Append the Gate-2 rows and re-derive the summary. Exported so the counts the
 * exit code reads are the counts the fixtures assert.
 */
export function withTargetChecks(result, rows) {
  const checks = [...result.checks, ...rows];
  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    },
    { ok: 0, warn: 0, crit: 0, info: 0 },
  );
  return { ...result, checks, summary };
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
  "  node .claude/bin/loom-doctor.mjs --targets       probe Gate-2 target branch protection",
  "  node .claude/bin/loom-doctor.mjs --targets --target-base main   (skip the default-branch lookup)",
  "  node .claude/bin/loom-doctor.mjs --target-repo <key|owner/repo>  probe ONE target (implies --targets)",
  "  node .claude/bin/loom-doctor.mjs --help",
  "",
  "Checks role, node/git/gh/az, line-endings, the coc-ledger merge driver,",
  "VCS-host auth, and the resolver — all at once, each with a remediation.",
  "--fix repairs the safe subset (autocrlf, merge-driver, resolver seed, and",
  "the .coc-role marker with an explicit --role); it never touches hook-mediated",
  "state. Run `loom doctor` BEFORE /onboard.",
  "",
  "--targets is the ONE check that leaves this repo: for each Gate-2 target in",
  "the ecosystem config it reports whether that repo's default branch carries",
  "≥1 REQUIRED status check and whether enforce_admins is on. Read-only and",
  "REPORT-ONLY — it never writes to a target (the target's owner remediates).",
  "It fails CLOSED: an API error, a bare 404, or a permission denial reports",
  "CRIT/UNKNOWN, never 'protected'. Off by default so an unattended run makes",
  "no cross-repo calls.",
  "",
  "--target-repo narrows that probe to ONE repo, by resolver key or owner/repo",
  "slug. It is an ALLOWLIST, not a free-form slug: the only accepted values are",
  "the Gate-2 targets --targets already probes, plus this repo's own origin. It",
  "NARROWS the enumeration and cannot widen it, so it grants no reach --targets",
  "lacks and is not a route around /cross-repo-authorize. Anything else is",
  "REFUSED at crit before a single API call is made.",
  "",
];

async function main(argv) {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP.join("\n") + "\n");
    return 0;
  }
  const result = runDoctor();

  // Gate-2 target rows. Probed ONLY under --targets; otherwise a visible
  // NOT-PROBED row, because an unrun check rendered as silence reads exactly
  // like a clean one. Resolved BEFORE the --fix branch so `--fix --targets`
  // honours the flag instead of dropping it (`zero-tolerance.md` Rule 3c — a
  // documented flag accepted with no effect is the silent-fallback mode at the
  // CLI surface). Nothing here is repairable by --fix: loom MUST NOT edit
  // another repo's branch protection, so the rows are reported after the
  // repair pass, never acted on.
  const targetRows = flags.targets
    ? (await runTargetChecks({ base: flags.targetBase, targetRepo: flags.targetRepo })).checks
    : [notProbedRow()].filter(Boolean);

  if (flags.fix) {
    const fix = runFix(result, { role: flags.role });
    process.stdout.write(formatFixReport(fix) + "\n\n");
    const after = withTargetChecks(runDoctor(), targetRows); // post-repair state
    process.stdout.write(formatReport(after) + "\n");
    return exitCode(after, flags);
  }

  const full = withTargetChecks(result, targetRows);

  if (flags.json) {
    process.stdout.write(JSON.stringify(full) + "\n");
    return exitCode(full, flags);
  }

  process.stdout.write(formatReport(full) + "\n");
  return exitCode(full, flags);
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
