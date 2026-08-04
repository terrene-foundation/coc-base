#!/usr/bin/env node
/**
 * Hook: settings-deny-edit-guard
 * Event: PreToolUse (Edit | Write | NotebookEdit)
 * Purpose: #1309 L1 — the WITHIN-SESSION prevention layer for the
 *          .claude/settings.json self-protection contract.
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
 *   over the parsed object; it is not a lexical regex over a command string. FAIL-OPEN
 *   on ambiguity (not settings.json, unreadable/uncomputable result) so the block
 *   fires only on a high-confidence under-protection.
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

const fs = require("fs");
const path = require("path");
// NB: imported as `osMod` (not `os`) — applyEdits() below uses a local `os` for `old_string`.
const osMod = require("os");
// Mutation-tool SSOT (cc-artifacts.md Rule 8): consult isMutationTool rather than a
// bare tool-name list, covering Edit / Write / MultiEdit / NotebookEdit + any future
// addition. (MultiEdit is removed from CC ~v2.0.8, so the settings.json matcher stays
// Edit|Write|NotebookEdit per tool-classes.js guidance — in-code coverage is the belt.)
const { isMutationTool } = require("./lib/tool-classes.js");
// Canonical-shape registration recognition SSOT (redteam R4 F5/F7). Shared with
// the L3 drift-guard so L1 + L3 can never drift on what counts as a genuine
// `node <…/hooks/marker>` invocation (a substring test false-accepts a DEAD
// `echo node …` / `node -pe …` obfuscation — see the helper's header).
const {
  invokesGuard,
  envKeysAddedOrChanged,
} = require("./lib/settings-deny-guard-shape.js");

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
  "Edit(.claude/learning/.heartbeat-cache*)",
  "Edit(.claude/learning/.session-end-cache*)",
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

const TIMEOUT_MS = 5000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

function passthrough() {
  clearTimeout(_timeout);
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

function blockDeny(reason, kind) {
  clearTimeout(_timeout);
  const { emit } = require("./lib/instruct-and-wait.js");
  emit({
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

// Classify which settings file `fp` targets, and how much of the contract applies to it:
//   { path, kind: "primary", label }   — the project .claude/settings.json: deny floor + guard
//                                         registrations + env → FULL invariant.
//   { path, kind: "env-only", label }  — a MERGED sibling: project .claude/settings.local.json
//                                         (gitignored, agent-creatable), user ~/.claude/settings.json,
//                                         or ~/.claude/settings.local.json. CC merges the hierarchy
//                                         into the hook subprocess, so a dangerous `env` key in ANY
//                                         reaches the guards like the primary's — but the deny floor +
//                                         registrations live ONLY in the primary, so a sibling gets
//                                         the env check ALONE.
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
  const userClaude = path.join(osMod.homedir(), ".claude"); // the user-global .claude dir
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

  // 1. EXISTING file → inode identity (FS-exact; resolves every OS name-fold).
  if (sameNode(abs, primary))
    return { path: primary, kind: "primary", label: ".claude/settings.json" };
  const siblings = [
    {
      p: path.join(projClaude, "settings.local.json"),
      label: ".claude/settings.local.json",
    },
    {
      p: path.join(userClaude, "settings.json"),
      label: "~/.claude/settings.json",
    },
    {
      p: path.join(userClaude, "settings.local.json"),
      label: "~/.claude/settings.local.json",
    },
  ];
  for (const s of siblings) {
    if (sameNode(abs, s.p))
      return { path: s.p, kind: "env-only", label: s.label };
  }

  // 2. NOT-YET-EXISTENT target → PARENT-dir inode identity + a single folded basename.
  const parent = path.dirname(abs);
  const base = foldBasename(path.basename(abs));
  const inProject = sameNode(parent, projClaude);
  const inUser = !inProject && sameNode(parent, userClaude);
  if (inProject || inUser) {
    const scope = inProject ? ".claude" : "~/.claude";
    if (base === "settings.local.json")
      return {
        path: abs,
        kind: "env-only",
        label: `${scope}/settings.local.json`,
      };
    if (base === "settings.json")
      // project .claude/settings.json = PRIMARY; user ~/.claude/settings.json = merged env-only.
      return inProject
        ? { path: abs, kind: "primary", label: ".claude/settings.json" }
        : { path: abs, kind: "env-only", label: "~/.claude/settings.json" };
  }

  // 2b. USER-GLOBAL fallback when ~/.claude does NOT EXIST yet (R14-review-1). The step-2 parent
  //     inode check fails when userClaude is absent (statSync throws → sameNode false → null →
  //     passthrough), re-opening the unguarded merged-sibling env-write class on the user scope
  //     (realistic on fresh machines / CI containers). Still STRUCTURAL: anchor at the HOME dir
  //     (ALWAYS exists) by inode, and fold the two tail components (the `.claude` dir + basename).
  //     Project scope needs NO fallback — projClaude always exists (this hook runs from .claude/hooks/).
  const home = osMod.homedir();
  if (
    foldBasename(path.basename(parent)) === ".claude" &&
    sameNode(path.dirname(parent), home)
  ) {
    if (base === "settings.local.json")
      return {
        path: abs,
        kind: "env-only",
        label: "~/.claude/settings.local.json",
      };
    if (base === "settings.json")
      return { path: abs, kind: "env-only", label: "~/.claude/settings.json" };
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
function enforceEnvOnly(tool, ti, beforeText, target) {
  const label = settingsLabel(target);
  const comp = computeAfterText(tool, ti, beforeText);
  if (comp.passthrough) return passthrough();
  if (comp.uncomputable) {
    // A non-applying/empty old_string → CC rejects the WHOLE (atomic) tool call → nothing
    // lands, including any env add in a sibling edit → passthrough (not a bypass; the edit
    // does not apply). A real env add arrives as an applying edit / a Write, handled below.
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
  let afterObj;
  try {
    afterObj = JSON.parse(comp.afterText);
  } catch {
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
  const envRedirect = envKeysAddedOrChanged(beforeObj, afterObj);
  if (envRedirect.length) {
    return blockDeny(
      `${tool} to ${label} adds or changes guard-neutering env key(s): ${envRedirect.join(", ")} — CC merges this file's env into the hook subprocess, so the key would redirect the guard command's node execution/path, relocate a config or root it reads, forge the operator identity it authorizes against, or steer its git subprocess, neutering the #1309 protection while the primary settings.json deny contract + registrations stay intact.`,
      "env-redirect-sibling",
    );
  }
  return passthrough();
}

async function main(payload) {
  const tool = payload && payload.tool_name;
  if (!isMutationTool(tool)) return passthrough();
  const ti = (payload && payload.tool_input) || {};
  const cwd = (payload && payload.cwd) || process.cwd();
  const target = classifyTarget(ti.file_path || ti.notebook_path, cwd);
  if (!target) return passthrough(); // not a settings file this guard fences

  // A NotebookEdit targeting ANY settings file is never a legitimate settings edit.
  if (tool === "NotebookEdit") {
    return blockDeny(
      `A NotebookEdit targeting ${settingsLabel(target)} is not a legitimate settings edit.`,
      "notebook-edit",
    );
  }

  // Read the baseline. A MERGED sibling (env-only) may not exist yet (settings.local.json is
  // agent-creatable via Write) — a null baseline is valid there (env-empty).
  let beforeText = null;
  try {
    beforeText = fs.readFileSync(target.path, "utf8");
  } catch {
    if (target.kind === "primary") {
      // Absent primary (fresh repo): no deny floor / registrations exist yet to protect, but a
      // Write CREATING settings.json with a dangerous env still redirects future hooks (R14-sec-3).
      // Run the env-only check (the floor/registration invariants have no baseline to compare).
      return enforceEnvOnly(tool, ti, null, target);
    }
    beforeText = null; // env-only sibling: absent baseline = env-empty
  }

  // F16: a MERGED sibling gets the env-only invariant (no deny floor / registrations there).
  if (target.kind === "env-only") {
    return enforceEnvOnly(tool, ti, beforeText, target);
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

  // Enforce the protection invariant over the RESULT.
  let afterObj;
  try {
    afterObj = JSON.parse(afterText);
  } catch {
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
      `${tool} to .claude/settings.json adds or changes guard-neutering env key(s): ${envRedirect.join(", ")} — a settings.json env var that would redirect the guard's node execution/path, relocate a config or root it reads, forge the operator identity it authorizes against, or steer its git subprocess, neutering the protection while the registration stays intact.`,
      "env-redirect",
    );
  }

  return passthrough();
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    return passthrough();
  }
  main(payload).catch(() => passthrough());
});
