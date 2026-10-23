#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Edit|NotebookEdit|Write (guard) — the proposed settings mutation can be evaluated against the current protection invariant before writing.
 *
 * Hook: settings-deny-edit-guard
 * Event: PreToolUse (Edit | Write | NotebookEdit)
 *
 * @coc-codex-edit-gate — .claude/settings.json self-protection invariant. The
 *   policy extractor fans its CC edit-matcher registration out to the Codex
 *   `apply_patch` lane (mcp-guard, FF-AC6-1). The earlier "no apply_patch
 *   equivalent" reason is WITHDRAWN (2026-10-09): an apply_patch that edits
 *   the settings file IS the mutation this guard fences, and the native
 *   bridge projects the patch into the Write (`content`) / Edit
 *   (`old_string`,`new_string`) shape `applyEdits()` already computes the
 *   resulting bytes from. On the compatibility-wrapper path, where only the
 *   target path is projected, the documented fail-open (content absent →
 *   passthrough) is unchanged.
 * Purpose: #1309 L1 — the WITHIN-SESSION prevention layer for the
 *          .claude/settings.json self-protection contract; and (R1 HIGH-1) the
 *          write fence for every `.env` Gemini may load into its own environment —
 *          a write leaving a forbidden key (settings-deny-guard-shape.js::
 *          isDotenvForbiddenKey) in one is refused (enforceDotenv). DEPTH since R2
 *          HIGH-1: the boundary is the Gemini registration's `env -i` + the adapter's
 *          env allowlist; this fence covers the `bash -c` stage before them. Gemini
 *          reaches this guard through its adapter on `write_file|replace`
 *          (normalizeTool); the shell lane of the same fence is validate-bash-command.js,
 *          on Gemini's run_shell_command only.
 *
 *   .claude/settings.json carries the file-tool `permissions.deny` guards that
 *   fence every trust-posture state file, AND the PreToolUse/SessionStart hook
 *   registrations for this guard + the L3 drift-guard. posture-gate.js /
 *   integrity-guard.js do NOT cover settings.json (confirmed empirically), and L3
 *   only self-heals at the NEXT session — so a within-session file-tool edit could
 *   otherwise disarm the protection until the next SessionStart.
 *
 *   DESIGN — CANONICAL-SHAPE ENFORCEMENT (not removal-detection). The Tier-1
 *   redteam showed that "block edits that REMOVE a protected string" is whack-a-mole:
 *   a substring check is defeated by a decoy occurrence, a neutered live entry, a
 *   `replace_all` that the guard mis-models, a broken matcher, or a poisoned SSOT.
 *   Instead this guard computes the RESULTING settings.json and requires it to still
 *   satisfy the protection INVARIANT:
 *     (1) permissions.deny ⊇ the entries currently protected — anchored on a
 *         HARDCODED CANONICAL_DENY_FLOOR (NOT the mutable reconcile bin, so
 *         poisoning the bin's CANONICAL_STATE_DENY to [] cannot weaken the floor);
 *         the SSOT may only EXTEND the floor, never reduce it.
 *     (2) this guard is FUNCTIONALLY registered — a `type:"command"` hook whose
 *         command invokes settings-deny-edit-guard.js under a PreToolUse matcher
 *         covering Edit AND Write (a decoy string in `description`, a neutered
 *         `type`, or a broken matcher all FAIL this structural check).
 *     (3) the L3 drift-guard is FUNCTIONALLY registered under SessionStart.
 *   An edit that leaves the result under-protected on ANY axis is BLOCKED; a
 *   legitimate settings-manager edit (adds/changes OTHER settings) passes.
 *
 *   Severity BLOCK is grounded per hook-output-discipline.md MUST-2: the signal is
 *   STRUCTURAL — the resulting bytes are parsed and the protection invariant checked
 *   over the parsed object; it is not a lexical regex over a command string. PASSES
 *   on a verdict-level ambiguity (not a settings file this guard fences; an edit CC
 *   itself rejects because its old_string does not apply) so the block fires only on
 *   a high-confidence under-protection. A run that reaches NO verdict — an unreadable
 *   payload, a throw, a run past its budget — is not ambiguity and does NOT pass: it
 *   ends through `lib/guard-runner.js::runGuard`, which refuses with exit 2 naming
 *   this guard (`cc-artifacts.md` Rule 7; this row is `on_incomplete: "deny"`).
 *
 *   DIRECT REGISTRATION (ROOT ruling D2). This guard is the independent trust anchor
 *   for settings.json, so it stays registered DIRECTLY in settings.json rather than
 *   behind the dispatcher (`lib/settings-deny-guard-shape.js::canonicalGuardCommand`
 *   pins that registration byte-exact). Its host reads only the exit code, so it is
 *   built `standalone: true`: the runner itself emits the refusal as exit 2, even
 *   when replayed through the engine. budgetMs 16000 sits under the registration's
 *   timeout. A load failure of the runner is caught by the one try around its
 *   require (exit 2, a built-in refusal); every other library loads lazily inside the
 *   run, where the runner refuses its failure. Declared residual: a syntax error in
 *   THIS file never reaches either and exits 1 on the host, which Claude Code reads
 *   as non-blocking; the backstop is the CC-native `permissions.deny` Edit(...) array
 *   the file protects.
 *
 *   TRUST BOUNDARY (explicit, out of #1309 scope): editing THIS guard's own `.js`
 *   source (or another guard's) to neuter it is NOT prevented at CC-runtime — that
 *   is an inherent recursion (a guard cannot guard its own source). It is covered at
 *   DESIGN time by the self-referential-codify.md multi-agent redteam gate + git
 *   history, not at runtime. This guard fences the settings.json CONTENT surface.
 *
 *   ADJACENT BOUNDARY NOTES (out of #1309 scope — this guard fences the DISARM surface,
 *   i.e. edits that neuter the deny-floor / registrations / env, NOT general settings
 *   integrity): (R13-sec-4a) ADDING a NEW arbitrary `hooks.*` entry (e.g. a malicious
 *   PreToolUse command) does NOT disarm #1309 — both guards still run and still block —
 *   so it is a broader settings-integrity concern, not a #1309 bypass. (R13-sec-4b) IF
 *   CC exposed a settings-level GLOBAL hook-disable flag, setting it would defeat the
 *   registration-PRESENCE checks while the `hooks` array stays intact; no such flag is
 *   known in CC's settings schema (unverified — a documented residual, not an asserted gap).
 *   (R14-sec-2) A `permissions.defaultMode` change (e.g. to `bypassPermissions`) does NOT
 *   nullify the deny backstop: loom's live settings.json ALREADY runs `defaultMode:
 *   bypassPermissions` WITH the deny array as its trust-posture fence, and reconcile-settings-
 *   deny.mjs records "deny fires under bypassPermissions" (posture-gate.js primary-fence note) —
 *   so `deny` is enforced REGARDLESS of mode and adding the mode changes nothing. The guard
 *   therefore checks `permissions.deny` (the fence) and deliberately does NOT gate `defaultMode`
 *   (a legit settings-manager field loom itself sets) — a cleared residual, not a gap.
 */

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [],
 *     "network": false,
 *     "spawns": []
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "Read-only over the on-disk settings file(s) (statSync / readFileSync) — the verdict is emitted to stdout via lib/instruct-and-wait.js and nothing is written; lib/tool-classes.js and lib/settings-deny-guard-shape.js are pure predicates."
 * }
 */

const fs = require("fs");
const path = require("path");
// NB: imported as `osMod` (not `os`) — applyEdits() below uses a local `os` for `old_string`.
const osMod = require("os");
// The fail-closed run boundary (D2: standalone — this guard is registered directly). The ONE
// library required at load, and its load failure is caught (R1 MED-3): the host reads only the
// exit code, so a guard-runner.js that will not load must still refuse with exit 2 rather than
// fall to node's exit 1, which Claude Code reads as non-blocking. Run as the CLI it refuses
// itself, here; required by the engine or a test, it re-throws so the caller's own load-failed
// refusal names it.
let runGuard;
try {
  ({ runGuard } = require("./lib/guard-runner.js"));
  // R2 NEW-A: a runner that LOADS but exports no runGuard (an emptied file) is the same
  // condition as one that will not load — refused here, not a TypeError at the call below.
  if (typeof runGuard !== "function") throw new Error("lib/guard-runner.js loaded but exports no runGuard function");
} catch (e) {
  if (require.main !== module) throw e;
  const why = String((e && e.message) || e).split("\n")[0].slice(0, 300);
  process.stderr.write(
    `[settings-deny-edit-guard] DENY: lib/guard-runner.js could not be loaded (${why}). This guard fences .claude/settings.json and cannot evaluate the call without its run boundary, so the call is refused. Restore .claude/hooks/lib/guard-runner.js from your own terminal (git checkout -- .claude/hooks/lib/guard-runner.js).\n`,
  );
  process.exit(2);
}

// Every OTHER library is loaded LAZILY, inside the run (R1 MED-3): a broken one throws into
// main, where guard-runner.js::runGuard refuses with exit 2 — at load it would be node's exit 1.
//   tool-classes.js            the mutation-tool SSOT (cc-artifacts.md Rule 8): isMutationTool
//                              rather than a bare tool-name list (Edit / Write / MultiEdit /
//                              NotebookEdit; MultiEdit is removed from CC ~v2.0.8, so the
//                              settings.json matcher stays Edit|Write|NotebookEdit).
//   settings-deny-guard-shape.js  the canonical-shape registration recognition SSOT (redteam R4
//                              F5/F7), shared with the L3 drift-guard so L1 + L3 never drift on
//                              what counts as a genuine `node <…/hooks/marker>` invocation, plus
//                              the env-key predicates.
let toolClassesLib = null;
let shapeLib = null;
function toolClasses() {
  return toolClassesLib || (toolClassesLib = require("./lib/tool-classes.js"));
}
function shape() {
  return shapeLib || (shapeLib = require("./lib/settings-deny-guard-shape.js"));
}
const invokesGuard = (...a) => shape().invokesGuard(...a);
const envKeysAddedOrChanged = (...a) => shape().envKeysAddedOrChanged(...a);
const ownProtoKeyPaths = (...a) => shape().ownProtoKeyPaths(...a);

// HARDCODED trust anchor (redteam F2): the minimum permissions.deny set the result
// MUST retain. Inlined here — NOT read from the mutable reconcile-settings-deny.mjs bin
// — so poisoning that bin's CANONICAL_STATE_DENY cannot reduce the enforced floor. The
// bin's SSOT may only EXTEND this floor (add new guards), never reduce below it. Kept in
// lockstep with reconcile-settings-deny.mjs::CANONICAL_STATE_DENY + the settings.json
// deny array by settings-deny-canon-parity.test.mjs.
const CANONICAL_DENY_FLOOR = [
  "Edit(.claude/learning/posture.json)",
  "Edit(.claude/learning/posture.json.bak)",
  "Edit(.claude/learning/posture.json.tmp.*)",
  "Edit(.claude/learning/violations.jsonl)",
  "Edit(.claude/learning/violations.jsonl.*)",
  "Edit(.claude/learning/.initialized)",
  "Edit(.claude/learning/presence-mechanism.json)",
  "Edit(.claude/operators.roster.json)",
  "Edit(.claude/learning/coordination-log.jsonl)",
  "Edit(.claude/learning/burndown-events.pending.jsonl*)",
  "Edit(.claude/learning/.heartbeat-cache*)",
  "Edit(.claude/learning/.session-end-cache*)",
  "Edit(.claude/learning/hook-findings/**)",
  "Edit(.claude/learning/fleet/**)",
];

// The guard hook registrations the result MUST retain, checked FUNCTIONALLY (redteam
// F1/F4) — a `type:"command"` hook whose command invokes the marker filename under the
// required event/matcher, NOT a bare substring anywhere in the file.
const GUARD_HOOK_SPECS = [
  {
    marker: "settings-deny-edit-guard.js",
    event: "PreToolUse",
    matcherCoversEditWrite: true,
  },
  {
    marker: "settings-deny-drift-guard.js",
    event: "SessionStart",
    matcherCoversEditWrite: false,
  },
];

// The standalone run budget guard-runner.js::runGuard enforces — under the direct
// registration's own timeout, so a budget refusal (exit 2) lands before a host kill.
const BUDGET_MS = 16000;

function passthrough() {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

// The refusal for a Gemini-loaded env file (R1 HIGH-1): the same severity and escalation as a
// settings refusal, with its own why / report / summary.
function blockDotenv(reason, kind) {
  const { emit } = require("./lib/instruct-and-wait.js");
  emit({
    escalate: "security",
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: reason,
    why: "gemini-env-file (R1/R2 HIGH-1) — Gemini loads the first `.gemini/.env` / `.env` on the path from its workspace up to `~/.gemini/.env` / `~/.env` into its own process environment, and runs every hook command as `bash -c` with it. The registration's `env -i` keeps it out of the hook adapter and every guard, but that bash starts first: a key it acts on at start-up (BASH_ENV, SHELLOPTS, a loader key — settings-deny-guard-shape.js::isDotenvForbiddenKey) would run code before any guard. The bytes the write would leave are checked; a benign env file is not blocked.",
    agent_must_report: [
      "Quote the env file and the loader key(s) the write would leave in it",
      "State why the project needs that key; an agent does not set one — the operator does, from their own terminal",
    ],
    agent_must_wait: "Do not retry, and do not route the write through another tool or the shell (a Bash write to an env file is refused too).",
    user_summary: `Gemini env-file write blocked (${kind})`,
  });
}

function blockDeny(reason, kind) {
  const { emit } = require("./lib/instruct-and-wait.js");
  emit({
    escalate: "security",
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: reason,
    why: "settings-deny-self-protection/#1309 — .claude/settings.json carries the file-tool permissions.deny guards for every trust-posture state file AND the registrations of this guard + the SessionStart drift-guard. The edit would leave the result under-protected (a missing deny guard, or a removed/disabled/mis-registered guard hook), disarming the fence for the rest of the session (L3 only self-heals at the NEXT SessionStart). A legitimate settings-manager / `/settings` edit that keeps the protection intact is not blocked.",
    agent_must_report: [
      "Quote the exact edit and which protection it removes (a deny guard entry, or a guard hook registration)",
      "State whether you intended to change the protected deny set or the guard registrations",
      "To INTENTIONALLY change the canonical deny set, update CANONICAL_STATE_DENY in .claude/bin/reconcile-settings-deny.mjs, CANONICAL_DENY_FLOOR in this guard, AND the settings.json deny array together (the documented SSOT + trust-anchor sites) — never an ad-hoc strip",
    ],
    agent_must_wait:
      "Do not retry. Canonical protection changes route through the SSOT + trust-anchor sites, not a lone settings.json edit.",
    user_summary: `settings.json self-protection strip blocked (#1309${kind ? ", " + kind : ""})`,
  });
}

// Conservative filename fold for a NOT-YET-EXISTENT target's basename (R13-sec-1). macOS-APFS
// (Unicode case-fold), Windows-NTFS (upcase), and Win32 (trailing dot/space strip at open) all fold
// MORE than case onto `settings[.local].json`, so a sibling CC would READ as a settings file must be
// classified even before it exists. `.toLowerCase()` alone closed only the CASE axis (missed the
// long-s ſ→s APFS fold + the Win32 trailing-dot/space strip → null → passthrough → unguarded env).
// This over-approximates the OS name-equivalence: NFKC (compatibility decomposition — long-s,
// fullwidth, ligatures) + NTFS stream-suffix strip (R14-sec-1) + trailing dot/space strip (Win32) +
// toLowerCase (case). An OS fold OUTSIDE this set on a not-yet-existent sibling is a DOCUMENTED
// RESIDUAL — an EXISTING file is inode-EXACT.
//   NTFS ALTERNATE-DATA-STREAM suffix (R14-sec-1): on Windows `settings.local.json::$DATA`,
//   `settings.local.json:$DATA`, and `settings.local.json:` all address the SAME default data stream
//   `open("settings.local.json")` reads (the historic `web.config::$DATA` bypass class) — win32
//   basename keeps the `:` suffix, so an un-stripped fold would classify null → passthrough. We cut
//   at the first `:` (NFKC first, so a fullwidth colon `：`→`:` is caught). `:` is not a valid char
//   in a settings filename on any platform, so cutting it is fail-CLOSED on POSIX too (a POSIX
//   `settings.local.json:evil` is a distinct file CC would not read as settings → a harmless over-flag).
function foldBasename(name) {
  return name
    .normalize("NFKC")
    .split(":")[0]
    .replace(/[.\s]+$/u, "")
    .toLowerCase();
}

// THE resolver for every path this guard takes a trust decision on — candidate and boundary root
// alike (rules/security.md § Path Containment). realpath the deepest EXISTING ancestor and re-append
// the not-yet-existent tail. A DANGLING symlink on the way is followed to its target (a Write through
// it creates that target, so the target is what CC later reads — R2 F1). Returns null when the path
// will not resolve — any realpath / lstat / readlink error other than ENOENT, a dangling link whose
// parent will not realpath, or a link chain longer than 40 hops — and every caller treats null as
// FAIL-CLOSED.
const MAX_LINK_HOPS = 40;
function canonicalPath(p) {
  let cur = path.resolve(p);
  const tail = [];
  let hops = 0;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...[...tail].reverse());
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
    }
    let link = null;
    try {
      const st = fs.lstatSync(cur);
      // realpath said ENOENT, yet the entry EXISTS and is not a link: never climb past it (a race
      // at best) — refuse (train-8 R2: the corr F1 class, found by the widened path-containment detector (A3d)).
      if (!st.isSymbolicLink()) return null;
      link = fs.readlinkSync(cur);
    } catch (e) {
      if (!e || e.code !== "ENOENT") return null;
    }
    if (link !== null) {
      if (++hops > MAX_LINK_HOPS) return null;
      // The kernel resolves a RELATIVE target against the link's REAL parent, not the path as
      // written: through a symlinked ancestor `alias/L -> ../x` lands beside the real parent, not
      // beside `alias` (M-W4.3 R2 MED). lstat succeeded, so the parent resolves; if it does not,
      // fail closed.
      let parent;
      try {
        parent = fs.realpathSync(path.dirname(cur));
      } catch {
        return null;
      }
      cur = path.resolve(parent, link);
      continue;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    tail.push(path.basename(cur));
    cur = up;
  }
}

// canonicalPath, then every component folded (foldBasename) so an OS name-fold of a missing
// component compares equal. Over-approximates on a case-sensitive FS — fail-closed, since the only
// consequence of a match is the env-only check.
function foldPath(real) {
  return real.split(/[\\/]+/).map(foldBasename).join("/");
}
function canonicalFolded(p) {
  const real = canonicalPath(p);
  return real === null ? null : foldPath(real);
}

// The user-scope config dirs Claude Code reads settings env from (M-W4.3 RUN 8 R2 Q4): CC resolves
// its config dir as `CLAUDE_CONFIG_DIR ?? ~/.claude`, and csq gives every terminal its own
// CLAUDE_CONFIG_DIR — so a guard that knew only ~/.claude never saw the file the live session
// reads. BOTH are fenced (fail-closed): ~/.claude still serves every session launched without the
// variable. CLAUDE_CONFIG_DIR is itself a dangerous settings-env key, so a settings file cannot
// move this scope out from under the guard.
function userConfigDirs() {
  const dirs = [{ dir: path.join(osMod.homedir(), ".claude"), scope: "~/.claude" }];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (typeof cfg === "string" && cfg)
    dirs.push({ dir: path.resolve(cfg), scope: "$CLAUDE_CONFIG_DIR" });
  return dirs;
}

// The basenames Claude Code reads as a settings file (R2 F3). CC 2.1.300 string table:
//   `var Nv={default:"settings.json",cowork:"cowork_settings.json"};function Xb(e){if(e.coworkPlugins||
//    a.CLAUDE_CODE_USE_COWORK_PLUGINS)return Nv.cowork;return Nv.default}` — the user-scope name — plus
//   settings.local.json for the local scope. cowork_settings.json is fenced in every `.claude` dir,
//   not only the user scope CC reads it from: an over-approximation that costs only the env check.
const SETTINGS_BASENAMES = new Set([
  "settings.json",
  "settings.local.json",
  "cowork_settings.json",
]);
// The global-config basenames whose top-level `env` CC also applies (`filterSettingsEnv(
// globalConfig.env)`, R2 Q4) — the FULL name set (R2 F2). CC 2.1.300 string table:
//   `var Hge=["","-staging-oauth","-local-oauth","-custom-oauth"]` → `.claude${suffix}.json` in
//   `CLAUDE_CONFIG_DIR||homedir()`; and `W_()` returns `<config home>/.config.json` IN PLACE of it when
//   that file is non-empty (`_.isFile()&&(_.size>0||…)`).
const GLOBAL_CONFIG_BASENAMES = new Set([
  ".config.json",
  ".claude.json",
  ".claude-staging-oauth.json",
  ".claude-local-oauth.json",
  ".claude-custom-oauth.json",
]);
// A directory holding any of these IS a Claude Code config dir, wherever it sits (R2 F1): CC 2.1.300
// lists its config-dir files as `_ks=[...Svr,d0t,sUe,iUe]` = the global-config set + `.credentials.json`
// (+ `.device-keys.json`, which CC keeps under ~/.claude only).
const CONFIG_DIR_MARKERS = [...GLOBAL_CONFIG_BASENAMES, ".credentials.json"];

// Is `dir` a directory Claude Code reads user-scope settings or global config from — for THIS session
// or for ANY other (R2 F1: csq gives every terminal its own CLAUDE_CONFIG_DIR, ~130 of them under
// ~/.claude/accounts/, and a Write into another terminal's dir lands env in THAT session's hooks).
// Recognised STRUCTURALLY, never by name enumeration — any one suffices:
//   (a) a `.claude` dir (a project's, a sibling worktree's, ~/.claude);
//   (b) this session's user config dirs (userConfigDirs);
//   (c) CONTAINED in ~/.claude/accounts/ — both sides through canonicalPath, OS-folded;
//   (d) it carries a CONFIG_DIR_MARKERS file.
// FAIL-CLOSED: a dir (or the accounts root) that will not resolve counts as a config dir.
function isConfigDir(dir) {
  const real = canonicalPath(dir);
  if (real === null) return true;
  if (
    foldBasename(path.basename(dir)) === ".claude" ||
    foldBasename(path.basename(real)) === ".claude"
  )
    return true;
  for (const u of userConfigDirs()) {
    const cu = canonicalFolded(u.dir);
    if (cu === null || cu === foldPath(real)) return true;
  }
  const root = canonicalFolded(path.join(osMod.homedir(), ".claude", "accounts"));
  if (root === null) return true;
  const cand = foldPath(real);
  if (cand === root || cand.startsWith(root + "/")) return true;
  return CONFIG_DIR_MARKERS.some((m) => {
    try {
      fs.lstatSync(path.join(real, m)); // lstat: a dangling `.credentials.json` link still marks it
      return true;
    } catch (e) {
      return !e || e.code !== "ENOENT";
    }
  });
}

// Classify which settings file `fp` targets, and how much of the contract applies to it:
//   { path, kind: "primary", label }   — the project .claude/settings.json: deny floor + guard
//                                         registrations + env → FULL invariant.
//   { path, kind: "env-only", label }  — a MERGED sibling: project .claude/settings.local.json
//                                         (gitignored, agent-creatable), a SETTINGS_BASENAMES or
//                                         GLOBAL_CONFIG_BASENAMES file in ANY Claude Code config dir
//                                         (isConfigDir — this session's, another terminal's, a
//                                         marker-bearing dir, any other `.claude` dir such as a
//                                         sibling worktree's), a global-config file in $HOME, or a
//                                         `.claude*.json` global-config file anywhere. CC merges
//                                         each into the hook subprocess, so a dangerous `env` key in
//                                         ANY reaches the guards like the primary's — but the deny
//                                         floor + registrations live ONLY in the primary, so a
//                                         sibling gets the env check ALONE.
//   null                               — not a settings file this guard fences.
//
// STRUCTURAL, not lexical (R13-sec-1 closure). An EXISTING file matches by FILE IDENTITY (inode+dev
// via `fs.statSync` — follows symlinks (P-B), resolves hardlinks (R4 NEW-1), AND every OS name-fold,
// since statSync goes through the real FS). A NOT-YET-EXISTENT target (Write-create) has no inode,
// but its PARENT dir does — so its `.claude` dir is matched by PARENT inode identity (eliminating ALL
// mid-path folding of `.claude` itself: `.Claude`, `.claude.`, a symlinked/UNC dir, native separators
// via platform-aware path.dirname), and ONLY the single fuzzy component — the basename — is folded
// (foldBasename). This replaces the per-fold lexical `.endsWith` whack-a-mole (case → backslash →
// long-s → trailing-dot …) with one FS-anchored check + one bounded basename fold.
function classifyTarget(fp, cwd) {
  if (typeof fp !== "string" || !fp) return null;
  const abs = path.resolve(cwd || process.cwd(), fp); // normalizes `..` for abs + rel
  const projClaude = path.resolve(__dirname, ".."); // the project .claude dir
  const userDirs = userConfigDirs(); // ~/.claude AND $CLAUDE_CONFIG_DIR (R2 Q4)
  const home = osMod.homedir();
  const primary = path.join(projClaude, "settings.json");

  const sameNode = (a, b) => {
    try {
      const sa = fs.statSync(a); // follows symlinks; a hardlink shares the inode
      const sb = fs.statSync(b);
      return sa.ino === sb.ino && sa.dev === sb.dev;
    } catch {
      return false; // a and/or b does not resolve (a Write creating a not-yet-existent file)
    }
  };

  // 1. EXISTING file → inode identity (FS-exact; resolves every OS name-fold and a hardlink).
  if (sameNode(abs, primary))
    return { path: primary, kind: "primary", label: ".claude/settings.json" };
  const siblings = [
    {
      p: path.join(projClaude, "settings.local.json"),
      label: ".claude/settings.local.json",
    },
  ];
  for (const b of GLOBAL_CONFIG_BASENAMES)
    siblings.push({ p: path.join(home, b), label: `~/${b}` });
  for (const u of userDirs) {
    for (const b of [...SETTINGS_BASENAMES, ...GLOBAL_CONFIG_BASENAMES])
      siblings.push({ p: path.join(u.dir, b), label: `${u.scope}/${b}` });
  }
  for (const s of siblings) {
    if (sameNode(abs, s.p))
      return { path: s.p, kind: "env-only", label: s.label };
  }

  // 2. NOT-YET-EXISTENT project .claude/settings.json → PRIMARY, by PARENT-dir identity + a single
  //    folded basename (every other not-yet-existent target is the class rule's).
  if (
    sameNode(path.dirname(abs), projClaude) &&
    foldBasename(path.basename(abs)) === "settings.json"
  )
    return { path: abs, kind: "primary", label: ".claude/settings.json" };

  // 3. CLASS rule — a target is env-bearing when its basename is a settings or global-config name
  //    AND its dir is a CC config dir (isConfigDir: structural, R2 F1), or it is a global-config
  //    name in $HOME, or a `.claude*.json` global-config name anywhere (R2 Q4/F2). Tested on the
  //    lexical path AND on canonicalPath of the target, so a symlink (dangling included) whose
  //    target is such a file, or a symlinked dir standing in for a config dir, is classified by
  //    what CC reads. FAIL-CLOSED: a target that will not resolve is env-bearing. A HARDLINK under
  //    an unrelated name to an unenumerated config dir's file is NOT seen (documented residual;
  //    step 1 sees hardlinks to the enumerated files).
  const real = canonicalPath(abs);
  if (real === null)
    return { path: abs, kind: "env-only", label: `${abs} (does not resolve)` };
  for (const f of new Set([abs, real])) {
    const b = foldBasename(path.basename(f));
    const dir = path.dirname(f);
    const isGlobal = GLOBAL_CONFIG_BASENAMES.has(b);
    if (!isGlobal && !SETTINGS_BASENAMES.has(b)) continue;
    if (
      (isGlobal && b.startsWith(".claude")) ||
      (isGlobal && canonicalFolded(dir) === canonicalFolded(home)) ||
      isConfigDir(dir)
    )
      return { path: abs, kind: "env-only", label: f };
  }
  return null;
}

// `invokesGuard` (the "does this command GENUINELY run the guard, not merely mention
// it" predicate) lives in ./lib/settings-deny-guard-shape.js — the SSOT shared with
// the L3 drift-guard. It rejects shell-obfuscated dead forms (echo node …, false &&
// node …, node -pe …) that a substring test false-accepts (redteam R4 F5/F7,
// co-owner-ratified IN-SCOPE). A DEAD-but-accepted registration would let an Edit
// neuter the layer AND make L3 skip restoring it; the canonical-shape check closes it.

// Is `spec`'s guard FUNCTIONALLY registered in a parsed settings.json object?
function isGuardRegistered(obj, spec) {
  const groups =
    obj && obj.hooks && Array.isArray(obj.hooks[spec.event])
      ? obj.hooks[spec.event]
      : [];
  return groups.some((g) => {
    if (spec.matcherCoversEditWrite) {
      // The matcher MUST cover the FULL mutation surface Edit|Write|NotebookEdit —
      // dropping NotebookEdit (R4 NEW-2) would leave a NotebookEdit strip of
      // settings.json un-guarded (the guard's own NotebookEdit hard-block never fires).
      const m = typeof g?.matcher === "string" ? g.matcher : "";
      const tokens = m.split("|").map((s) => s.trim());
      if (!(
        tokens.includes("Edit") &&
        tokens.includes("Write") &&
        tokens.includes("NotebookEdit")
      ))
        return false;
    }
    const hs = Array.isArray(g?.hooks) ? g.hooks : [];
    return hs.some(
      (h) => h && h.type === "command" && invokesGuard(h.command, spec.marker),
    );
  });
}

// Apply an Edit/MultiEdit `edits` list to `text`, honoring per-edit `replace_all`
// (redteam F3 — CC removes ALL occurrences when replace_all is set). Returns
// { text } on clean application, or { uncomputable:true } when an edit does not apply
// (a non-existent / empty old_string — CC rejects it).
function applyEdits(text, edits) {
  for (const ed of edits) {
    const os = ed && ed.old_string;
    const ns = ed && typeof ed.new_string === "string" ? ed.new_string : "";
    if (typeof os !== "string" || os.length === 0)
      return { uncomputable: true };
    if (text.indexOf(os) === -1) return { uncomputable: true };
    // Both branches insert new_string LITERALLY, matching CC. The single-replace
    // branch uses a FUNCTION replacer `() => ns` (NOT `text.replace(os, ns)`) so that
    // `$`-patterns in an attacker-controlled new_string (`$&`, `` $` ``, `$'`, `$$`,
    // `$1`-`$9`) are NOT interpreted (redteam R4 F6): a string replacement arg expands
    // them, diverging the guard-computed result from CC-real and false-ALLOWing a strip.
    text =
      ed && ed.replace_all
        ? text.split(os).join(ns)
        : text.replace(os, () => ns);
  }
  return { text };
}

// R2 LOW — an OWN `__proto__` key at ANY nesting level of the result. JSON.parse makes it an
// ordinary own property, but a settings merge that copies keys onto an object (CC merges every
// settings source into one) can write it as the PROTOTYPE instead, so keys hidden under it surface
// as inherited properties of the merged settings. How CC's merge treats it was not traced; no
// legitimate settings file carries the key, so it is refused at every depth (fail-closed), on the
// primary and every merged sibling alike.
function blockProto(tool, label, protoKeys) {
  return blockDeny(
    `${tool} to ${label} carries an own __proto__ key at ${protoKeys.join(", ")} — a settings merge can apply it as the prototype of the merged settings, surfacing env or permissions no reviewer sees as a plain key. No legitimate settings file needs it.`,
    "proto-key",
  );
}

// A human-readable label for the target file (used in block messages).
// The human-readable label for the target — carried on the classifyTarget result so it names the
// EXACT file matched (fixes R13-review MINOR-1: a case-sensitive suffix check mislabeled a
// capital-cased sibling). `classifyTarget` always sets `label`; fall back defensively.
function settingsLabel(target) {
  return (target && target.label) || ".claude/settings.json";
}

// Compute the resulting text of the edit, or signal uncomputable / passthrough.
// Returns { afterText } | { uncomputable, edits } | { passthrough:true }.
function computeAfterText(tool, ti, beforeText) {
  if (tool === "Write") {
    if (typeof ti.content !== "string") return { passthrough: true };
    return { afterText: ti.content };
  }
  // Edit / MultiEdit on a file with no baseline: CC rejects editing a non-existent file →
  // nothing lands → passthrough.
  if (beforeText == null) return { passthrough: true };
  const edits =
    tool === "MultiEdit"
      ? Array.isArray(ti.edits)
        ? ti.edits
        : null
      : [
          {
            old_string: ti.old_string,
            new_string: ti.new_string,
            replace_all: ti.replace_all,
          },
        ];
  if (!edits || edits.length === 0) return { passthrough: true };
  const res = applyEdits(beforeText, edits);
  if (res.uncomputable) return { uncomputable: true, edits };
  return { afterText: res.text };
}

// F16 — the env-only invariant for a MERGED sibling settings file (settings.local.json /
// user-global): CC merges its `env` into the hook subprocess, so an ADD/CHANGE of a
// guard-redirecting env key neuters BOTH guards exactly as a primary-file add would. The deny
// floor + guard registrations live ONLY in the primary, so a sibling gets the env check ALONE.
function enforceEnvOnly(tool, ti, beforeText, target, fuzzy) {
  const label = settingsLabel(target);
  const comp = computeAfterText(tool, ti, beforeText);
  if (comp.passthrough) return passthrough();
  if (comp.uncomputable) {
    // A non-applying/empty old_string → CC rejects the WHOLE (atomic) tool call → nothing
    // lands, including any env add in a sibling edit → passthrough (not a bypass; the edit
    // does not apply). A real env add arrives as an applying edit / a Write, handled below.
    // Gemini's replace matches flexibly where the exact text is absent (GEMINI_WRITE_TOOLS),
    // so there the bytes are unknown and the call is refused.
    if (fuzzy)
      return blockDeny(
        `${tool} to ${label}: its old_string does not occur exactly, and Gemini's replace then matches flexibly, so the resulting settings env cannot be checked. Quote the exact text being replaced, or write the whole file.`,
        "settings-uncomputable-fuzzy",
      );
    return passthrough();
  }
  // Baseline: a missing sibling (common — settings.local.json is agent-creatable) OR a
  // malformed one is treated as env-empty, so every dangerous key in the result is "added".
  let beforeObj = null;
  if (typeof beforeText === "string") {
    try {
      beforeObj = JSON.parse(beforeText);
    } catch {
      beforeObj = null;
    }
  }
  // A parse failure here is a VERDICT INPUT, not an error path: it is recorded and decided below,
  // outside the catch, so no decision is ever made inside an error handler.
  let afterObj;
  let afterNonStrict = false;
  try {
    afterObj = JSON.parse(comp.afterText);
  } catch {
    afterNonStrict = true;
  }
  if (afterNonStrict) {
    // Result is not STRICT-JSON parseable. Do NOT assume CC's settings parser also rejects it —
    // its JSONC/JSON5 leniency is not guaranteed, and a lenient parser BOTH accepts a trailing
    // comma AND decodes `\uXXXX` escapes, so any lexical key scan is defeatable (a `"PATH"`
    // key evades it while CC decodes it to PATH; R12-sec-2). FAIL-CLOSED unconditionally: block
    // ANY non-strict-parseable sibling body — the exact posture the primary path already takes on
    // a malformed result (blockDeny "malformed"). If CC's parser is strict, a non-strict body is
    // inert and the block is harmless; if lenient, the block is the only sound defense (we cannot
    // safely determine its env without reimplementing CC's parser). Subsumes the R12-sec-3 `ENV`
    // container-collision (no key scan runs).
    return blockDeny(
      `${tool} to ${label} produces a NON-strict-JSON body — its env cannot be safely verified (CC's settings parser may accept it and merge a guard-redirecting env key). Blocked fail-closed; write strict JSON.`,
      "env-nonstrict-sibling",
    );
  }
  const protoKeys = ownProtoKeyPaths(afterObj);
  if (protoKeys.length) return blockProto(tool, label, protoKeys);
  const envRedirect = envKeysAddedOrChanged(beforeObj, afterObj);
  if (envRedirect.length) {
    return blockDeny(
      `${tool} to ${label} adds or changes guard-neutering env key(s): ${envRedirect.join(", ")} — CC merges this file's env into the hook subprocess, so the key would redirect the guard command's node execution/path, make a hook process load attacker code or run its commands through a wrapper, relocate a config or root it reads, forge the operator identity it authorizes against, or steer its git subprocess, neutering the #1309 protection while the primary settings.json deny contract + registrations stay intact.`,
      "env-redirect-sibling",
    );
  }
  return passthrough();
}

// ── R1 HIGH-1 — the Gemini env file ──────────────────────────────────────────────────────────
// Gemini loads a `.env` into its own process.env, and every hook child inherits it — the Gemini
// adapter included, before its own env scrub can run — so a loader key there (NODE_OPTIONS
// --require, DYLD_INSERT_LIBRARIES, …) runs code inside the boundary that answers for every
// deny guard (settings-deny-guard-shape.js § THE GEMINI ENV FILE). It is the same class this
// guard already fences for settings env: an agent write that injects env into the hook process.
//
// Gemini's own write tools reach this guard through the adapter (`.gemini/settings.json`
// BeforeTool `write_file|replace`), in Gemini's vocabulary; they are read as the CC tool whose
// shape they carry. Gemini's `replace` does NOT only match literally — it falls back to
// whitespace-flexible, regex and fuzzy matching (Gemini CLI 0.41.2 bundle,
// calculateExactReplacement → calculateFlexibleReplacement → calculateRegexReplacement →
// calculateFuzzyReplacement) — so a `replace` whose old_string does not occur exactly has a
// result this guard cannot compute, and on a fenced file it is REFUSED rather than passed (a CC
// Edit in that state is rejected by CC itself, which is why CC's passes).
const GEMINI_WRITE_TOOLS = Object.freeze({ write_file: "Write", replace: "Edit" });

// The tool as this guard reads it: { tool, ti, fuzzy, gemini }. A Gemini write tool becomes its CC
// shape; `allow_multiple` is Gemini's replace_all. `fuzzy` marks a host whose edit may apply where
// the exact old_string is absent; `gemini` marks Gemini's own write tools, whose written bytes
// Gemini may TRANSFORM (enforceDotenv's host-transform checks).
function normalizeTool(rawTool, rawTi) {
  const ti = rawTi && typeof rawTi === "object" ? rawTi : {};
  if (!Object.prototype.hasOwnProperty.call(GEMINI_WRITE_TOOLS, rawTool)) return { tool: rawTool, ti, fuzzy: false, gemini: false };
  const tool = GEMINI_WRITE_TOOLS[rawTool];
  if (tool === "Write") return { tool, ti: { file_path: ti.file_path, content: ti.content }, fuzzy: true, gemini: true };
  return {
    tool,
    ti: { file_path: ti.file_path, old_string: ti.old_string, new_string: ti.new_string, replace_all: ti.allow_multiple === true },
    fuzzy: true,
    gemini: true,
  };
}

// Does Gemini's replace reach its LLM edit fixer on this call? Gemini replaces only when the
// edit applies cleanly; otherwise — no occurrence, more than one without allow_multiple, or an
// old_string equal to its new_string (Gemini CLI 0.41.2 bundle, chunk-6DSAZLFF.js
// `getErrorReplaceResult`) — and with LLM correction on, it asks a model to rewrite the edit
// (`EditToolInvocation.attemptSelfCorrection` -> `FixLLMEditWithInstruction`) and applies
// THAT. The rewrite's bytes are not the call's, so on a fenced file such a call is refused.
function geminiReplaceReachesFixer(ti, beforeText) {
  const os = ti.old_string;
  if (typeof os !== "string" || os.length === 0 || typeof beforeText !== "string") return true;
  const n = beforeText.split(os).length - 1;
  if (n === 0) return true;
  if (!ti.replace_all && n !== 1) return true;
  return os === ti.new_string;
}

// Is `abs` a file Gemini's env loader may open — by the name it is written under, or (a
// symlink) by the file it lands in? Resolved through canonicalPath (security.md § Path
// Containment); a path that will not resolve is treated as one (fail-closed).
function dotenvTarget(fp, cwd) {
  if (typeof fp !== "string" || !fp) return null;
  const abs = path.resolve(cwd || process.cwd(), fp);
  const real = canonicalPath(abs);
  const named = shape().isGeminiEnvFileName(path.basename(abs));
  if (real === null) return named ? { path: abs, label: `${abs} (does not resolve)` } : null;
  if (named || shape().isGeminiEnvFileName(path.basename(real))) return { path: abs, label: real === abs ? abs : `${abs} -> ${real}` };
  return null;
}

// Every text the write could put in the file: the computed result, plus the raw new content
// itself (a host may transform what it writes; the literal is read too).
function dotenvCandidateTexts(tool, ti, afterText) {
  const texts = [];
  if (typeof afterText === "string") texts.push(afterText);
  if (typeof ti.content === "string") texts.push(ti.content);
  if (typeof ti.new_string === "string") texts.push(ti.new_string);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.new_string === "string") texts.push(e.new_string);
  return texts;
}

function enforceDotenv(tool, ti, target, fuzzy, gemini) {
  if (tool === "NotebookEdit")
    return blockDotenv(`A NotebookEdit targeting ${target.label} — a Gemini-loaded env file — is never a legitimate env edit.`, "dotenv-notebook-edit");
  // The baseline, decided OUTSIDE the catch: absent → null (a create); unreadable → refuse (the
  // keys already in it cannot be read, so the result cannot be judged).
  let beforeText = null;
  let readErr = null;
  try {
    beforeText = fs.readFileSync(target.path, "utf8");
  } catch (e) {
    readErr = e || new Error("the env file could not be read");
  }
  if (readErr !== null && readErr.code !== "ENOENT" && readErr.code !== "ENOTDIR") throw readErr;
  // R2 HIGH-1 Gap A — a write whose bytes Gemini would TRANSFORM before writing them. The key
  // scan below reads the text in the call; Gemini's write_file may write its escape conversion
  // of it, or an LLM rewrite (settings-deny-guard-shape.js::geminiWriteFileUnescape), and its
  // replace may apply an LLM rewrite of the edit (geminiReplaceReachesFixer). Neither is the text
  // this guard can read, so on a Gemini-loaded env file such a write is refused; one Gemini
  // writes byte-for-byte is checked as usual.
  if (gemini && tool === "Write" && shape().geminiWriteFileConverts(ti.content))
    return blockDotenv(
      `Gemini write_file to ${target.label} — a Gemini-loaded env file — carries an escape sequence (\\n, \\t, \\r, \\", \\', \\\`, \\\\) that Gemini's write_file converts before writing, so the bytes it would leave are not the text this guard can check. Write the file with real line breaks and no backslash escapes.`,
      "dotenv-host-conversion",
    );
  if (gemini && tool === "Edit" && beforeText !== null && geminiReplaceReachesFixer(ti, beforeText))
    return blockDotenv(
      `Gemini replace on ${target.label} — a Gemini-loaded env file — does not apply cleanly (its old_string must occur exactly once, or allow_multiple be set, and differ from new_string), and Gemini then has a model rewrite the edit, so the bytes it would write are unknown. Quote the exact text being replaced, or write the whole file with write_file.`,
      "dotenv-uncomputable",
    );
  let afterText = null;
  if ((tool === "Edit" || tool === "MultiEdit") && beforeText === null) {
    // Creating through an edit: an empty old_string makes the file from new_string (Gemini's
    // replace does; read it as such on every host — fail-closed). Anything else does not apply.
    const edits = tool === "MultiEdit" ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
    if (!edits.length || !edits.every((e) => e && e.old_string === "")) return passthrough();
    afterText = edits.map((e) => (typeof e.new_string === "string" ? e.new_string : "")).join("");
  } else {
    const comp = computeAfterText(tool, ti, beforeText);
    if (comp.passthrough) return passthrough();
    if (comp.uncomputable) {
      if (fuzzy)
        return blockDotenv(
          `${tool} to ${target.label} — a Gemini-loaded env file — cannot be checked: its old_string does not occur exactly, and Gemini's replace then matches flexibly, so the bytes it would write are unknown. Write the whole file with write_file, or quote the exact text being replaced.`,
          "dotenv-uncomputable",
        );
      return passthrough(); // CC rejects a non-applying Edit: nothing lands
    }
    afterText = comp.afterText;
  }
  const keys = [...new Set(dotenvCandidateTexts(tool, ti, afterText).flatMap((t) => shape().dotenvLoaderKeys(t)))].sort();
  if (keys.length)
    return blockDotenv(
      `${tool} to ${target.label} leaves env key(s) ${keys.join(", ")} in a file Gemini loads into its own environment at start-up. Gemini runs every hook command as \`bash -c\` with that environment, and a key that makes bash or the dynamic loader run code at start-up (BASH_ENV, SHELLOPTS, LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, …) would run that code before any guard. An agent never writes one; if the project genuinely needs it, the operator sets it from their own terminal.`,
      "dotenv-loader-key",
    );
  return passthrough();
}

async function main(payload) {
  // Load the libraries FIRST, inside the run, so a broken one is the runner's refusal.
  toolClasses();
  shape();
  const norm = normalizeTool(payload && payload.tool_name, payload && payload.tool_input);
  const tool = norm.tool;
  if (!toolClasses().isMutationTool(tool)) return passthrough();
  const ti = norm.ti;
  const cwd = (payload && payload.cwd) || process.cwd();
  const target = classifyTarget(ti.file_path || ti.notebook_path, cwd);
  if (!target) {
    const env = dotenvTarget(ti.file_path || ti.notebook_path, cwd);
    if (env) return enforceDotenv(tool, ti, env, norm.fuzzy, norm.gemini);
    return passthrough(); // not a settings or env file this guard fences
  }

  // A NotebookEdit targeting ANY settings file is never a legitimate settings edit.
  if (tool === "NotebookEdit") {
    return blockDeny(
      `A NotebookEdit targeting ${settingsLabel(target)} is not a legitimate settings edit.`,
      "notebook-edit",
    );
  }

  // Read the baseline. The read failure is a VERDICT INPUT, recorded in the catch and decided
  // OUTSIDE it (no decision is made in an error handler):
  //   - a MERGED sibling (env-only) that is absent (settings.local.json is agent-creatable via
  //     Write) OR unreadable (a symlink loop, EACCES, …) gets a null baseline = env-EMPTY, the
  //     STRICTEST baseline: every dangerous key in the result counts as added;
  //   - an ABSENT primary (ENOENT/ENOTDIR: a fresh repo) gets the env-only check below;
  //   - a primary that EXISTS but cannot be read is no baseline at all. It is re-thrown, so the
  //     run boundary refuses, rather than letting it skip the deny-floor and registration
  //     invariants as an absent one would.
  let beforeText = null;
  let readErr = null;
  try {
    beforeText = fs.readFileSync(target.path, "utf8");
  } catch (e) {
    readErr = e || new Error("the settings baseline could not be read");
  }
  if (readErr !== null && target.kind === "primary") {
    if (readErr.code !== "ENOENT" && readErr.code !== "ENOTDIR") throw readErr;
    // Absent primary (fresh repo): no deny floor / registrations exist yet to protect, but a
    // Write CREATING settings.json with a dangerous env still redirects future hooks (R14-sec-3).
    // Run the env-only check (the floor/registration invariants have no baseline to compare).
    return enforceEnvOnly(tool, ti, null, target, norm.fuzzy);
  }

  // F16: a MERGED sibling gets the env-only invariant (no deny floor / registrations there).
  if (target.kind === "env-only") {
    return enforceEnvOnly(tool, ti, beforeText, target, norm.fuzzy);
  }

  // ── primary .claude/settings.json: the FULL protection invariant ──────────────────────
  // The reconcile-bin SSOT may only EXTEND the hardcoded floor (never reduce it): an
  // import failure OR a poisoned/empty CANONICAL_STATE_DENY simply falls back to the
  // floor (redteam F2/P-C). A non-empty CANON adds any new guards beyond the floor.
  let ssotExtra = [];
  try {
    const mod = await import(
      path.join(__dirname, "..", "bin", "reconcile-settings-deny.mjs")
    );
    if (Array.isArray(mod.CANONICAL_STATE_DENY))
      ssotExtra = mod.CANONICAL_STATE_DENY;
  } catch {
    ssotExtra = [];
  }
  const requiredDeny = [...new Set([...CANONICAL_DENY_FLOOR, ...ssotExtra])];

  // Parse the baseline. A malformed baseline is anomalous → strict mode (require the
  // FULL required set + both registrations in the result).
  let beforeObj = null;
  let baselineMalformed = false;
  try {
    beforeObj = JSON.parse(beforeText);
  } catch {
    baselineMalformed = true;
  }
  const beforeDenySet = new Set(
    beforeObj && Array.isArray(beforeObj?.permissions?.deny)
      ? beforeObj.permissions.deny
      : [],
  );
  // Entries the RESULT must retain: baseline malformed → the full required set;
  // else → the required entries currently present (an already-absent one is not
  // "removed" by this edit).
  const protectedNow = baselineMalformed
    ? requiredDeny
    : requiredDeny.filter((e) => beforeDenySet.has(e));

  // Compute the resulting text (NotebookEdit already handled above).
  const comp = computeAfterText(tool, ti, beforeText);
  if (comp.passthrough) return passthrough();
  let afterText;
  if (comp.uncomputable && norm.fuzzy)
    return blockDeny(
      `${tool} to .claude/settings.json: its old_string does not occur exactly, and Gemini's replace then matches flexibly, so the resulting protection cannot be checked. Quote the exact text being replaced, or write the whole file.`,
      "settings-uncomputable-fuzzy",
    );
  if (comp.uncomputable) {
    // Cannot compute the exact result (a non-applying/empty old_string — CC rejects
    // it). Textual fallback: block if any edit removes a protected deny entry OR a
    // guard-hook marker; else pass (the edit lands no strip).
    const removedFloor = [];
    const removedHook = [];
    for (const ed of comp.edits) {
      const os = typeof ed?.old_string === "string" ? ed.old_string : "";
      const ns = typeof ed?.new_string === "string" ? ed.new_string : "";
      for (const e of protectedNow)
        if (os.includes(e) && !ns.includes(e)) removedFloor.push(e);
      // Registration strip: the old fragment carried a GENUINE invocation of the
      // marker AND the new fragment does NOT (R4 NEW-3 — route through invokesGuard,
      // not a bare `ns.includes(marker)` substring, so replacing a live registration
      // with a DEAD `echo node <marker>` obfuscation is still caught here).
      for (const s of GUARD_HOOK_SPECS)
        if (invokesGuard(os, s.marker) && !invokesGuard(ns, s.marker))
          removedHook.push(s.marker);
    }
    if (removedHook.length)
      return blockDeny(
        `${tool} to .claude/settings.json removes a settings-deny guard hook registration: ${[...new Set(removedHook)].join(", ")}.`,
        "guard-hook-strip",
      );
    if (removedFloor.length)
      return blockDeny(
        `${tool} to .claude/settings.json removes trust-posture deny guard(s): ${[...new Set(removedFloor)].join(", ")}.`,
        "strip",
      );
    return passthrough();
  }
  afterText = comp.afterText;

  // Enforce the protection invariant over the RESULT. As in enforceEnvOnly, the parse failure is a
  // verdict input recorded in the catch and DECIDED outside it.
  let afterObj;
  let afterMalformed = false;
  try {
    afterObj = JSON.parse(afterText);
  } catch {
    afterMalformed = true;
  }
  if (afterMalformed) {
    // Result does not parse. Already-malformed baseline is not made worse → passthrough.
    // A previously-VALID baseline left malformed disables the fence → block.
    if (baselineMalformed) return passthrough();
    return blockDeny(
      `${tool} to .claude/settings.json would leave it malformed, disabling the trust-posture deny contract.`,
      "malformed",
    );
  }

  // (1) deny ⊇ protectedNow.
  const afterDenySet = new Set(
    Array.isArray(afterObj?.permissions?.deny) ? afterObj.permissions.deny : [],
  );
  const missingDeny = protectedNow.filter((e) => !afterDenySet.has(e));
  if (missingDeny.length) {
    return blockDeny(
      `${tool} to .claude/settings.json removes trust-posture deny guard(s): ${missingDeny.join(", ")}.`,
      "strip",
    );
  }

  // (2)+(3) each guard functionally registered in the result IF it was in the baseline
  // (or unconditionally when the baseline was malformed / strict mode).
  for (const spec of GUARD_HOOK_SPECS) {
    const mustHave = baselineMalformed || isGuardRegistered(beforeObj, spec);
    if (mustHave && !isGuardRegistered(afterObj, spec)) {
      return blockDeny(
        `${tool} to .claude/settings.json removes or disables the ${spec.marker} ${spec.event} registration.`,
        "guard-hook-strip",
      );
    }
  }

  // (3b) no own `__proto__` key at ANY depth (R2 LOW) — see blockProto.
  const protoKeys = ownProtoKeyPaths(afterObj);
  if (protoKeys.length)
    return blockProto(tool, ".claude/settings.json", protoKeys);

  // (4) settings.json `env` MUST NOT ADD/CHANGE a key that neuters a guard while its registration
  // stays byte-identical (redteam R9 F13; #1429; #1471 F2/F3). The env reaches the hook subprocess,
  // so such a key can (a) redirect node execution — `PATH` / `NODE_OPTIONS` / `CLAUDE_PROJECT_DIR` /
  // `DYLD_*` / `LD_*`; (b) redirect the policy config or a root a guard reads —
  // `LOOM_ECOSYSTEM_CONFIG` / `CLAUDE_TRUST_STATE_DIR` / `KAILASH_LEARNING_DIR`; (c) forge the
  // OPERATOR IDENTITY a guard authorizes against — the `COC_` namespace; or (d) steer the GIT
  // SUBPROCESS a guard reaches before any identity check — the `GIT_` namespace. A malformed
  // baseline (beforeObj null) treats every dangerous key in the result as added.
  const envRedirect = envKeysAddedOrChanged(beforeObj, afterObj);
  if (envRedirect.length) {
    return blockDeny(
      `${tool} to .claude/settings.json adds or changes guard-neutering env key(s): ${envRedirect.join(", ")} — a settings.json env var that would redirect the guard's node execution/path, make a hook process load attacker code or run its commands through a wrapper, relocate a config or root it reads, forge the operator identity it authorizes against, or steer its git subprocess, neutering the protection while the registration stays intact.`,
      "env-redirect",
    );
  }

  return passthrough();
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file (the direct
// settings.json registration) and by hook-engine.js::runCli's selftest replay. A require() has no
// side effects: guard-runner.js::runGuard arms its budget timer and reads stdin only when a run
// starts, and it refuses (exit 2) an unreadable payload, a throw, or a run past BUDGET_MS — the
// endings the old timer (continue:true, exit 1) and `.catch(passthrough)` let through.
const hookMain = runGuard("settings-deny-edit-guard", main, { budgetMs: BUDGET_MS, standalone: true });

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
