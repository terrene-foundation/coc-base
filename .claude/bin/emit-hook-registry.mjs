#!/usr/bin/env node
/**
 * ============================================================================
 *  emit-hook-registry — emit the per-repo `loom.hook-registry/v1` contract
 * ============================================================================
 *
 *  WHAT IT IS. The repo-relative `.claude/hook-registry.json` — a
 *  manifest of every hook the target repo will actually RUN: event, matcher,
 *  file + its bytes, the transitive local-require closure of each hook, the
 *  runtime entries those verdicts flow through, order, the
 *  incomplete/crash/timeout contract, the execution pool, and the [D]-derived
 *  / [A]-declared / [M]-measured facts a consolidating consumer needs. Its
 *  sibling `<manifest>.sig` carries the signature when the signing path is
 *  available. The consumer verifies `file_sha256`, every `deps[].sha256` and
 *  every `runtimes[]` pin before dispatching a hook and REFUSES on mismatch
 *  (`.claude/hook-registry.json` is the AGREED path — a consumer reads it
 *  there, not from under `.claude/hooks/`).
 *
 *  THE DELIVERY SET COMES FROM A PLAN, NEVER FROM A GLOB. `--plan <file>` is
 *  the JSON a real `sync-tier-aware.mjs --build <target> --dry-run --json` run
 *  produced. The emitter reads `plan.files[]` ACTIONS (`action === "copy"`) and
 *  drops only LOOM-TEMPLATE rows whose file the lane does not deliver. A
 *  repo-owned row (source repo-local / third-party) is KEPT whatever the plan
 *  says: its file is the repo's own, the plan describes loom's deliveries, and
 *  a dropped row is a guard that silently never runs.
 *
 *  USAGE
 *
 *    node .claude/bin/emit-hook-registry.mjs --target base --lane build \
 *         --plan <plan.json>                      # writes .claude/hook-registry.json
 *    node .claude/bin/emit-hook-registry.mjs --target base --lane build --plan <plan.json> --stdout
 *    node .claude/bin/emit-hook-registry.mjs --target base --lane build --plan <plan.json> --sign
 *    node .claude/bin/emit-hook-registry.mjs --check <manifest.json> --target … --plan …
 *
 *  FLAGS
 *    --root <dir>              the tree to DESCRIBE (default: the emitter's own)
 *    --target <name>           the sync target the plan was built for (REQUIRED)
 *    --lane build|use          which lane (default: the plan's own mode)
 *    --plan <path>             sync-tier-aware --dry-run --json output
 *    --all-rows                ignore delivery, emit every declared row (loud; tests)
 *    --local-registry <path>   include repo-owned rows (dispatch-registry.local.json)
 *    --source-sha <40hex>      emitting commit (default: git rev-parse HEAD)
 *    --require-source-match    fail if a hook's bytes differ from its blob at source_sha
 *    --out <path>              write here (default: <root>/.claude/hook-registry.json)
 *    --stdout                  print the document instead of writing a file
 *    --json                    machine-readable run report on stderr
 *    --check <path>            fail unless the emitted bytes equal this file
 *    --sign                    also write <manifest>.sig (skipped LOUDLY if no key)
 *    --require-signature       fail instead of skipping when no signing key is available
 *    --allow-missing-surface <name>  declare an EXPECTED-absent registration surface
 *    --help                    this text (exit 0)
 *
 *  EXIT CODES: 0 = emitted/matched; 1 = emit failure (missing or malformed
 *  @hook-contract, a declaration the source contradicts, unknown event,
 *  unresolved or dynamic require, an absent registration surface, a
 *  source_sha mismatch under --require-source-match, --check mismatch); 2 =
 *  usage error.
 *
 *  DETERMINISM: rows sorted by (canonical event order, order, id); `deps` and
 *  every list sorted; fixed key order within every object; JSON.stringify(…, 2)
 *  with exactly one trailing newline. A re-emit over an unchanged tree is
 *  byte-identical, and `--check` PROVES it rather than asserting it.
 * ============================================================================
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMITTER_ROOT = path.resolve(HERE, "..", "..");
// The tree the manifest DESCRIBES. `--root` points it at a synthetic tree (the
// fixture battery drives minimal roots that way); the TOOLS always load from
// the emitter's own tree, so a fixture can never swap the contract module out.
let ROOT = EMITTER_ROOT;
const require_ = createRequire(import.meta.url);

// The ONE write path for emitted text artifacts (loom#1684 terminator contract
// + the symlink-safe O_NOFOLLOW open), imported rather than re-implemented.
import { writeTextArtifactSync } from "./lib/coc-manifest.mjs";
import {
  privateOrgSlugs as emitPrivateOrgSlugs,
  assertPrivateOrgConfig,
  assertTreeFreeOfPrivateIdentity,
} from "./lib/strip-build-internal.mjs";

// THE HELPERED GIT. A PATH-resolved `git` with an INHERITED env is the surface
// that let a canon-tip redirect ship — the reason .claude/bin/** is ratcheted,
// and this file was caught on that ratchet's first run. Absolute binary, env
// built from constants, never inherited.
const { resolveGitBinary, gitEnv } = require_(path.join(EMITTER_ROOT, ".claude", "hooks", "lib", "git-subprocess-env.js"));
const GIT_BIN = resolveGitBinary();
const GIT_ENV = gitEnv();
const contract = require_(path.join(EMITTER_ROOT, ".claude", "hooks", "lib", "hook-registry-contract.js"));
const dispatchRegistry = require_(path.join(EMITTER_ROOT, ".claude", "hooks", "lib", "dispatch-registry.js"));
const cocSign = require_(path.join(EMITTER_ROOT, ".claude", "hooks", "lib", "coc-sign.js"));
const { refusalTokens } = require_(path.join(EMITTER_ROOT, ".claude", "bin", "check-deny-capable-declarations.mjs"));

const HOOKS_REL = ".claude/hooks";
const EMITTER_REL = ".claude/bin/emit-hook-registry.mjs";
const SIG_SCHEME = "loom.hook-registry.sig/v1";

/**
 * The registration surfaces this emitter EXPECTS to read. Absence is
 * FAIL-CLOSED by default: those files are how `surfaces` and `payload_stdin`
 * are derived, and a snapshot missing one of them would silently emit a
 * NARROWER document (a consumer would then believe a CLI does not run a hook).
 * `--allow-missing-surface <name>` declares an expected absence explicitly.
 */
const EXPECTED_SURFACE_SOURCES = [
  { name: "settings", path: ".claude/settings.json" },
  { name: "dispatch-registry", path: ".claude/hooks/dispatch-registry.json" },
  { name: "codex-hooks", path: ".codex/hooks.json" },
  { name: "gemini-settings", path: ".gemini/settings.json" },
];

/**
 * Dynamic requires the emitter is ALLOWED to leave unresolved. Each entry is a
 * DECLARATION keyed to a SITE — {file, line, shape, reason} — matching on both
 * file AND line, and the list is carried IN-DOCUMENT as
 * `dynamic_require_exemptions` so a consumer sees the hole rather than having to
 * trust there was none. NOT empty: one entry, for the dispatcher's own dynamic
 * module load (below). A site with no entry is a REFUSAL, and the refusal names
 * this list so the fix is one line.
 */
/**
 * One unresolvable site, rendered for a human: where it is, and — when the
 * walker could name it — WHAT it could not resolve and why. A refusal that says
 * only "not statically resolvable" makes the reader re-derive the site; naming
 * the specifier is what turns it into a decision.
 */
function describeDynamicSite(d) {
  const where = `${d.file}:${d.line}`;
  if (!d.specifier && !d.why) return where;
  const what = d.specifier ? JSON.stringify(d.specifier) : null;
  return `${where} (${[what, d.why].filter(Boolean).join(" — ")})`;
}

const DYNAMIC_REQUIRE_EXEMPTIONS = [
  // ── the codex-mcp-guard adapter: a LAYOUT-DEPENDENT root by design ────────
  // `HOOKS_DIR = path.join(COC_ROOT, "hooks")` where `COC_ROOT = resolveCocRoot(HERE)`
  // probes two install layouts at runtime, so no walker can assemble the base.
  // These entries were keyed to lines that MOVED when the adapter grew (~660
  // lines above them) and the emit refused until each was re-stated — the
  // fail-closed direction the line key is chosen for.
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 159,
    shape: 'require(path.join(HOOKS_DIR, CAPTURE_HOOK)) — CAPTURE_HOOK is a string const, but the HOOKS_DIR root is chosen at RUNTIME by resolveCocRoot(HERE), which probes two layouts',
    reason:
      "the dynamic root is layout-dependent by design, and the file it selects, provenance-capture-tool.js, is a ROW of this manifest (MEASURED: exactly one row carries it) — pinned by its own file_sha256 plus its own deps closure, which is a stronger pin than a closure edge would be.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 265,
    shape: 'require(path.join(HOOKS_DIR, "lib", "state-resolver.js")) — same runtime-chosen root',
    reason:
      "same layout-dependent base. The file it names IS pinned in this manifest by a STATIC route: MEASURED, state-resolver.js is a deps path in 105 places — every one of the 102 rows and all three runtime entries — reached through .claude/hooks/lib/append-sink.js, which requires it at its line 647. So the pin this edge would add is one the document already carries for every row, and the narrower fact is that THIS closure (server.js's own, one file) does not hold the edge.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 367,
    shape: "spawnSync(process.execPath, [hookPath]) — hookPath comes from resolveHookFile(hookFile) under the same layout-dependent root",
    reason:
      "the spawned file is a hook the codex policy registers, resolved by the adapter's own resolveHookFile — same runtime-chosen base, and the files it can select are this manifest's rows.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 725,
    shape: 'require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js"))',
    reason:
      "same layout-dependent base; MEASURED, the file is a deps entry of 4 rows of this manifest elsewhere, so its bytes are pinned in the document even though this closure cannot carry the edge.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 731,
    shape: 'require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js")) — the same read at the second site',
    reason: "same site class as line 725.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 749,
    shape: 'require(path.join(HOOKS_DIR, "lib", "hook-engine.js"))',
    reason:
      "same layout-dependent base; MEASURED, hook-engine.js is a deps entry of 103 rows of this manifest — the dispatcher's own module, pinned in the document elsewhere.",
  },
  {
    file: ".claude/codex-mcp-guard/server.js",
    line: 750,
    shape: 'require(path.join(HOOKS_DIR, "lib", "dispatch-registry.js")) — the same read at the third site',
    reason: "same site class as line 725.",
  },
  // ── the runtime entries ──────────────────────────────────────────────────
  {
    file: ".claude/hooks/lib/codex-hook-runtime.js",
    line: 379,
    shape: "spawnSync(process.execPath, [target, …args]) — `target` is the adapter's invocation argument",
    reason:
      "the target is resolved by resolveTarget: it is canonicalized under ROOT and matched against this file's HANDLERS list, so it can only be one of those eight named hooks (MEASURED: each of the eight appears exactly once as a ROW of this manifest, pinned by its own file_sha256 plus its own deps closure) — a path outside that list is still spawned, but with the default timeout and no validator role, and it would be a consumer's own repo-local row rather than a file this manifest could pin from here.",
  },
  {
    file: ".claude/hooks/lib/local-supervisor.js",
    line: 149,
    shape: "spawn(process.execPath, [d.file], …) — `d` is one detector record from the supervisor's input, not a path this file builds",
    reason:
      "the detector set is the DISPATCHER'S OWN row set: the supervisor is handed either explicit `detectors: [{file, timeoutMs}]` over fd 3 or a `select` it resolves against the registry (MEASURED at planLocalRows — the rows are selected out of the same registry that produced this manifest), and each of those files is a ROW of this manifest, pinned by its own file_sha256 plus its own deps closure.",
  },
  {
    file: ".claude/hooks/lib/hook-engine.js",
    line: 961,
    shape: "require(entry.file) — a computed specifier (this site read line 302 before the guard-foundation merge moved it)",
    reason:
      "`require(entry.file)` loads the hook modules the dispatcher was told to run. The dynamically-required set IS this manifest's rows, and every one of them is pinned separately by its own file_sha256 + deps closure — inlining a fixed list here would duplicate dispatch-registry.json and drift from it, and drift in that copy would be invisible.",
  },
  {
    file: ".claude/hooks/lib/coord-background.js",
    line: 157,
    shape: "spawn(process.execPath, [scriptPath, WORKER_FLAG]) — scriptPath is this function's PARAMETER",
    reason:
      "the HOOK callers pass `__filename`: MEASURED at multi-operator-sessionend.js (spawnDetachedWorker(__filename)) and multi-operator-sessionstart.js (both runBoundedWorker(__filename, …) and spawnDetachedCacheRebuild(__filename, …)), so the file spawned is the CALLING HOOK — a ROW of this manifest, pinned by its own file_sha256 plus its own deps closure, a stronger pin than a closure edge would be, and one no forward walk can see (the path is interprocedural). SCOPE: a test-harness caller in this tree passes a sandbox path instead of __filename, and there the spawn is suppressed by the held lock — so this declaration covers the hook callers, not every caller.",
  },
  {
    file: ".claude/hooks/lib/coord-background.js",
    line: 718,
    shape: "spawnSync(process.execPath, [scriptPath, WORKER_FLAG]) — the same parameter",
    reason: "same site class as line 157: the caller passes its own __filename, which is a row pinned by file_sha256 + deps.",
  },
  {
    file: ".claude/hooks/lib/coord-background.js",
    line: 1026,
    shape: "spawn(process.execPath, [scriptPath, CACHE_REBUILD_FLAG]) — the same parameter",
    reason:
      "same site class as line 157; this one's caller is multi-operator-sessionstart.js (`spawnDetachedCacheRebuild(__filename, PROJECT_DIR)`), again a row pinned by file_sha256 + deps.",
  },
  {
    file: ".claude/hooks/lib/codex-native-policy.js",
    line: 107,
    shape: 'spawnSync(process.execPath, ["-e", MATCHER_CHILD, require.resolve("./hook-engine")])',
    reason:
      "the inline program is MATCHER_CHILD — a template-literal CONST in this same file, so its bytes are the file's bytes, which `file_sha256` pins. The only module that program loads is `require(process.argv[1])`, i.e. the `require.resolve(\"./hook-engine\")` in this very argv — a form the evaluator branch reads, and MEASURED in this closure: hook-engine.js is present in the emitted deps.",
  },
  // ── the build-tool graph reached through validate-emit.mjs ───────────────
  {
    file: ".claude/hooks/auto-format.js",
    line: 299,
    shape: "execFileSync(process.execPath, [entry, …]) — entry comes from cachedPrettierEntry()",
    reason:
      "the entry is the PINNED PRETTIER PACKAGE's own bin inside npm's npx cache (MEASURED at cachedPrettierEntry: the path is resolved under cachedPrettierDir() and then contained against the real npx cache dir, with the package name and version read from the package's own manifest and compared to PRETTIER_PIN_NAME/PRETTIER_PIN_VERSION). Its bytes are an npm package's, not this repo's — the same boundary `deps` already declares for every node builtin and npm package — so no repo-relative pin can carry it.",
  },
  {
    file: ".claude/bin/lib/expanded-hook-settings.mjs",
    line: 30,
    shape: 'require_(lib) — lib = path.join(path.dirname(path.resolve(settingsPath)), "hooks", "lib", "dispatch-registry.js")',
    reason:
      "the FILE name is fixed, but its BASE is the directory of whichever settings file the CALLER passes (settingsPath is this function's parameter), so the walker cannot assemble a repo-relative path and refuses rather than guess a base. The selected name is the dispatcher's registry library — the same artifact this manifest is emitted from — and a consumer's own copy sits beside its own settings.json, where its own rows pin it.",
  },
  {
    file: ".claude/bin/lib/strip-build-internal.mjs",
    line: 1889,
    shape: "spawnSync(process.execPath, [path.join(libDir, \"strip-build-internal.mjs\"), …])",
    reason:
      "the spawned path is a SANDBOX COPY OF THIS VERY FILE: MEASURED a few lines above, `fs.cpSync(path.dirname(fileURLToPath(import.meta.url)), libDir, { recursive: true })` populates libDir from this file's own directory, so the child runs the parent's own bytes — already pinned by this file's file_sha256.",
  },
  {
    file: ".claude/bin/validate-xref-integrity.mjs",
    line: 1679,
    shape: "await import(url) — url binds pathToFileURL(join(repoRoot, \".claude\", \"bin\", \"sync-tier-aware.mjs\")).href",
    reason:
      "the import target is a repo file named through a URL BINDING (`const url = pathToFileURL(join(…)).href`), which the reader does not follow: the path expression is two calls deep and the walker refuses rather than guess. DECLARED HOLE — the file it names (.claude/bin/sync-tier-aware.mjs) is not pinned by this edge.",
  },
  {
    file: ".claude/bin/validate-xref-integrity.mjs",
    line: 1939,
    shape: "await import(url) — the same URL-binding form, naming .claude/bin/phase2-deferral-integrity.mjs",
    reason:
      "same site class as line 1679 in this file; DECLARED HOLE — the named file (.claude/bin/phase2-deferral-integrity.mjs) is not pinned by this edge.",
  },
];
// KEYED TO THE SITE (file + line), never to the file alone: a file-keyed
// exemption would silently cover every FUTURE dynamic require added to the most
// important runtime file in the tree. A line key rots on any edit above it, and
// that is the fail-CLOSED direction — the exemption stops matching, the emitter
// refuses, and someone re-states it deliberately. The list is also carried
// IN-DOCUMENT (`dynamic_require_exemptions`), so a consumer can see which holes
// were declared rather than having to trust that there were none.

// ── the lexed capability scan ───────────────────────────────────────────────

const WRITE_CALLS = new Set([
  "writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream",
  "mkdirSync", "mkdir", "unlinkSync", "unlink", "rmSync", "rm", "rmdirSync",
  "renameSync", "rename", "copyFileSync", "copyFile", "truncateSync", "truncate",
  "writeSync", "writevSync",
]);
const SPAWN_CALLS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
// `exec` is the ONE name in that set that is also an everyday METHOD on a
// non-process object — `someRegex.exec(line)` appears 5x in
// integration-hygiene.js alone, and a bare name match reded that hook's
// correctly-declared `spawns: false`. So `exec` counts only as a BARE call or
// one reached through a child_process binding.
const CHILD_PROCESS_RECEIVERS = new Set(["child_process", "childProcess", "cp"]);
const NET_METHODS = new Set(["fetch", "request", "connect", "lookup", "get"]);
// `get` IS IN THE SET BECAUSE IT IS THE SHORTHAND EVERY NODE HTTP CLIENT USES —
// `https.get(url, cb)` was the ONE network form the scan could not see, and the
// contract header named it as a boundary rather than a bug. It is safe to add:
// the match requires the RECEIVER to be one of NET_RECEIVERS, so `x.get(...)` on
// anything else is untouched, and MEASURED against this tree no hook or
// codex-mcp-guard file calls `.get(` on an http/https/net/dns/tls receiver at
// all — so no existing row's declaration is contradicted by the widening.
const NET_RECEIVERS = new Set(["http", "https", "net", "dns", "tls"]);

function lexedCapabilities(src) {
  const { tokens, ok, error } = tokenizeSrc(src);
  if (!ok) return { ok: false, error, writes: false, spawns: false, network: false, updatedInput: false };
  const V = (i, k) => (tokens[i + k] ? tokens[i + k].value : undefined);
  let writes = false;
  let spawns = false;
  let network = false;
  let updatedInput = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // QUOTED decision keys FIRST, before the ident guard below: a quoted key is
    // a STRING token, so placing this check after `if (t.type !== "ident")`
    // (the first attempt) left it unreachable and the evasion open.
    if (t.type === "string" && t.value === "updatedInput" && V(i, 1) === ":") updatedInput = true;
    // ...AND THE BRACKET FORM (`reply["updatedInput"] = …`), which the quoted-key
    // fix left open: that check requires the next token to be `:`, and a bracket
    // access closes with `]`. The value is the same rewrite either way, so the
    // form is a spelling, not a different act — a row that writes the reply this
    // way with `may_rewrite_input: false` is the same undeclared rewrite.
    if (t.type === "string" && t.value === "updatedInput" && V(i, 1) === "]") updatedInput = true;
    if (t.type !== "ident") continue;
    const called = V(i, 1) === "(";
    const isMethod = tokens[i - 1] !== undefined && tokens[i - 1].value === ".";
    const receiver = tokens[i - 2] !== undefined ? tokens[i - 2].value : undefined;
    const spawnish = SPAWN_CALLS.has(t.value) && (!isMethod || t.value !== "exec" || CHILD_PROCESS_RECEIVERS.has(receiver));
    if (called && WRITE_CALLS.has(t.value)) writes = true;
    if (called && spawnish) spawns = true;
    // NETWORK — the earlier revision of this line called the helper with ONE
    // argument, so `V(i + 1)` read tokens[i + 1 + undefined] = tokens[NaN] and
    // the whole check was DEAD (it could never fire). Fixed here and pinned by
    // the network-contradiction fixture.
    if (called && NET_METHODS.has(t.value) && !isMethod) network = true;
    if (called && NET_METHODS.has(t.value) && isMethod && NET_RECEIVERS.has(receiver)) network = true;
    if (t.value === "updatedInput") updatedInput = true;
  }
  return { ok: true, error: null, writes, spawns, network, updatedInput };
}

let tokenizeCache = null;
function tokenizeSrc(src) {
  if (!tokenizeCache) {
    tokenizeCache = require_(path.join(EMITTER_ROOT, ".claude", "hooks", "lib", "block-evidence-provenance.js")).tokenize;
  }
  return tokenizeCache(src);
}

/** `module.exports = { …, hookMain, … }` / `exports.hookMain = …` — lexed. */
function exportsHookMain(src) {
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return null;
  for (let i = 0; i < tokens.length - 3; i++) {
    const t = tokens[i];
    if (t.value === "module" && tokens[i + 1].value === "." && tokens[i + 2].value === "exports" && tokens[i + 3].value === "=") {
      if (tokens[i + 4] && tokens[i + 4].value !== "{") continue;
      let depth = 0;
      for (let j = i + 4; j < tokens.length; j++) {
        const v = tokens[j];
        if (v.value === "{") depth++;
        else if (v.value === "}") {
          depth--;
          if (depth === 0) return false;
        } else if (v.type === "ident" && v.value === "hookMain") return true;
      }
      return false;
    }
    if (t.value === "exports" && tokens[i + 1].value === "." && tokens[i + 2].value === "hookMain" && tokens[i + 3].value === "=") {
      return true;
    }
  }
  return false;
}

function readsProcessCwd(src) {
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return true; // unlexable → conservative value, never "payload"
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i].value === "process" && tokens[i + 1].value === "." && tokens[i + 2].value === "cwd" && tokens[i + 3].value === "(") return true;
  }
  return false;
}

function exitCodeShape(src) {
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return { literal: [], computed: true };
  const literal = new Set();
  let computed = false;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type !== "ident" || tokens[i].value !== "exit" || tokens[i + 1].value !== "(") continue;
    const arg = tokens[i + 2];
    if (arg && arg.type === "number") literal.add(Number(arg.value));
    else computed = true;
  }
  return { literal: [...literal].sort((a, b) => a - b), computed };
}

const DECISION_FIELD_ENUM = new Set([
  "continue", "hookSpecificOutput", "permissionDecision", "decision", "additionalContext",
  "systemMessage", "reason", "suppressOutput", "stopReason", "refuseHandback", "updatedInput",
]);

function decisionFields(src) {
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return [];
  const found = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !DECISION_FIELD_ENUM.has(t.value)) continue;
    const asKey = tokens[i + 1] && tokens[i + 1].value === ":";
    const asMember = tokens[i - 1] && tokens[i - 1].value === ".";
    if (asKey || asMember) found.add(t.value);
  }
  return [...found].sort();
}

/** Does the file (or its closure) reach `child_process` at all? Lexed. */
function requiresChildProcess(src) {
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return true;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== "ident" || tokens[i].value !== "require") continue;
    const arg = tokens[i + 2];
    if (arg && arg.type === "string" && /^(node:)?child_process(\/promises)?$/.test(arg.value)) return true;
  }
  return false;
}

// ── registration surfaces ───────────────────────────────────────────────────

function readJsonIfPresent(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function codexHandlerFiles() {
  const file = path.join(ROOT, HOOKS_REL, "lib", "codex-hook-runtime.js");
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return { files: new Set(), note: "codex-hook-runtime.js unreadable — codex handler surface NOT derived" };
  }
  const { tokens, ok } = tokenizeSrc(src);
  if (!ok) return { files: new Set(), note: "codex-hook-runtime.js unlexable — codex handler surface NOT derived" };
  const i = tokens.findIndex((t, idx) => t.type === "ident" && t.value === "HANDLERS" && tokens[idx + 1] && tokens[idx + 1].value === "=");
  if (i < 0) return { files: new Set(), note: "codex-hook-runtime.js has no HANDLERS array — codex handler surface NOT derived" };
  const files = new Set();
  let depth = 0;
  let started = false;
  for (let j = i + 1; j < tokens.length; j++) {
    const v = tokens[j];
    if (v.value === "[") {
      depth++;
      started = true;
    } else if (v.value === "]") {
      depth--;
      if (depth === 0 && started) break;
    } else if (started && depth >= 1 && v.type === "string" && v.value.endsWith(".js")) {
      files.add(v.value.replace(/^\.\//, "").replace(/^\.claude\/hooks\//, ""));
    }
  }
  if (files.size === 0) return { files, note: "codex HANDLERS array yielded no .js entries — codex handler surface NOT derived" };
  return { files, note: null };
}

function filesNamedIn(text) {
  const out = new Set();
  const re = /\.claude\/hooks\/([A-Za-z0-9._-]+\.js)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function deriveSurfaces(missingAllowed) {
  const absent = [];
  for (const s of EXPECTED_SURFACE_SOURCES) {
    if (!fs.existsSync(path.join(ROOT, s.path))) absent.push(s);
  }
  const unexpected = absent.filter((s) => !missingAllowed.has(s.name));
  if (unexpected.length) {
    fail(
      `registration surface(s) absent: ${unexpected.map((s) => `${s.path} (${s.name})`).join(", ")}. ` +
        `surfaces/payload_stdin are DERIVED from these, so a missing one silently NARROWS the document. ` +
        `Declare an expected absence with --allow-missing-surface <name> (${absent.map((s) => s.name).join(", ")}), or restore the file.`,
    );
  }
  const codex = readJsonIfPresent(path.join(ROOT, ".codex", "hooks.json"));
  const codexTemplate = readJsonIfPresent(path.join(ROOT, ".claude", "codex-templates", "hooks.json"));
  const gemini = readJsonIfPresent(path.join(ROOT, ".gemini", "settings.json"));
  const codexNamed = new Set([
    ...(codex ? filesNamedIn(JSON.stringify(codex)) : []),
    ...(codexTemplate ? filesNamedIn(JSON.stringify(codexTemplate)) : []),
  ]);
  const handlers = codexHandlerFiles();
  const geminiNamed = gemini ? filesNamedIn(JSON.stringify(gemini)) : new Set();
  return {
    codexNamed,
    geminiNamed,
    handlers,
    absent: absent.map((s) => s.name),
    notes: [handlers.note].filter(Boolean),
  };
}

function surfacesFor(event, file, surfaces) {
  const out = ["claude"];
  if (event === "PreToolUse" || surfaces.codexNamed.has(file) || surfaces.handlers.files.has(file)) out.push("codex");
  if (surfaces.geminiNamed.has(file)) out.push("gemini");
  return out;
}

// ── git ─────────────────────────────────────────────────────────────────────

function git(args) {
  // An unresolvable git binary returns null, never an empty string: every caller
  // treats null as "could not determine" and fails loudly from there
  // (source_sha, drift, the byte comparison), so the chain stays intact while no
  // un-helpered binary is ever spawned.
  if (!GIT_BIN) return null;
  const r = spawnSync(GIT_BIN, ["--no-optional-locks", ...args], { cwd: ROOT, encoding: "utf8", env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : null;
}

function headSha() {
  return git(["rev-parse", "HEAD"]);
}

/**
 * The GIT object id of a byte string. The git OBJECT ID and a sha256 are
 * different functions over the same bytes; the first version of `sourceDrift`
 * compared one against the other, which can never be equal — so it reported
 * EVERY file as drifted and read as "the tree is just dirty". Fixture case 30
 * pins the clean-tree pole that reds on that mistake.
 */
function gitBlobId(buf, algo) {
  return crypto.createHash(algo).update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`, "utf8"), buf])).digest("hex");
}

function sourceDrift(fileShas, sha) {
  if (!sha) return { checked: false, drifted: [], reason: "no source_sha available" };
  const listed = git(["ls-tree", "-r", "--name-only", sha, "--", `${HOOKS_REL}/`]);
  if (listed === null) return { checked: false, drifted: [], reason: `source_sha ${sha} is not resolvable in this clone` };
  const tracked = new Set(listed.split("\n").filter(Boolean));
  const drifted = [];
  for (const file of Object.keys(fileShas)) {
    if (!tracked.has(file)) {
      drifted.push(`${file} (untracked at ${sha})`);
      continue;
    }
    const blob = git(["rev-parse", `${sha}:${file}`]);
    if (blob === null) {
      drifted.push(`${file} (blob unreadable at ${sha})`);
      continue;
    }
    const algo = blob.length === 64 ? "sha256" : "sha1";
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(ROOT, file));
    } catch (err) {
      drifted.push(`${file} (unreadable: ${err.message})`);
      continue;
    }
    if (gitBlobId(bytes, algo) !== blob) drifted.push(file);
  }
  return { checked: true, drifted, reason: null };
}

/** Does this file's content equal loom's own blob at `sha`? */
function matchesTemplateBlob(rel, sha) {
  if (!sha) return false;
  const blob = git(["rev-parse", `${sha}:${rel}`]);
  if (blob === null) return false;
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(ROOT, rel));
  } catch {
    return false;
  }
  return gitBlobId(bytes, blob.length === 64 ? "sha256" : "sha1") === blob;
}

// ── arguments ───────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write(
    [
      "emit-hook-registry — emit the loom.hook-registry/v1 manifest for one target",
      "",
      "  --root <dir>              tree to DESCRIBE (default: the emitter's own repo)",
      "  --target <name>           sync target the plan was built for (required)",
      "  --lane build|use          which lane (default: the plan's own mode)",
      "  --plan <path>             sync-tier-aware --dry-run --json output",
      "  --all-rows                ignore delivery, emit every declared row (loud; tests only)",
      "  --local-registry <p>      include repo-owned rows (dispatch-registry.local.json)",
      "  --source-sha <40hex>      emitting commit (default: git rev-parse HEAD)",
      "  --require-source-match    fail when a hook's bytes differ from its blob at source_sha",
      "  --out <path>              write here (default: <root>/.claude/hook-registry.json)",
      "  --stdout                  print instead of writing",
      "  --sign                    also write <manifest>.sig (loudly skipped if no key)",
      "  --sign-key <path>         private key for the .sig (ssh by default; coc-sign owns the call)",
      "  --sign-key-type ssh|gpg   which coc-sign path to use (default ssh)",
      "  --require-signature       fail instead of skipping when no key is available",
      "  --allow-missing-surface <name>   declare an expected-absent surface",
      "  --dynamic-require-exempt <file:line>  exempt ONE dynamic require SITE (the report names the site)",
      "  --check <path>            fail unless the emitted bytes equal this file",
      "  --json                    machine-readable report on stderr",
      "  --help                    this text",
      "",
      "Exit codes: 0 = emitted/matched, 1 = emit failure, 2 = usage error.",
      "",
    ].join("\n"),
  );
  return msg ? 2 : 0;
}

function parseArgs(argv) {
  const args = {
    target: null, lane: null, plan: null, allRows: false, localRegistry: null, sourceSha: null,
    requireSourceMatch: false, out: null, stdout: false, check: null, json: false, root: null,
    sign: false, requireSignature: false, signKey: null, signKeyType: "ssh", allowMissingSurface: new Set(), dynamicExempt: new Set(),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--lane") args.lane = argv[++i];
    else if (a === "--plan") args.plan = argv[++i];
    else if (a === "--all-rows") args.allRows = true;
    else if (a === "--local-registry") args.localRegistry = argv[++i];
    else if (a === "--source-sha") args.sourceSha = argv[++i];
    else if (a === "--require-source-match") args.requireSourceMatch = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--stdout") args.stdout = true;
    else if (a === "--sign") args.sign = true;
    else if (a === "--require-signature") args.requireSignature = true;
    else if (a === "--sign-key") args.signKey = argv[++i];
    else if (a === "--sign-key-type") args.signKeyType = argv[++i];
    else if (a === "--allow-missing-surface") args.allowMissingSurface.add(argv[++i]);
    else if (a === "--dynamic-require-exempt") args.dynamicExempt.add(argv[++i]); // <file>:<line>
    else if (a === "--check") args.check = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") return { help: true };
    else return { error: `unknown argument: ${a}` };
  }
  if (!args.target) return { error: "--target is required (the plan's target)" };
  if (args.lane !== null && !["build", "use"].includes(args.lane)) return { error: `--lane must be build or use, got ${args.lane}` };
  // D3: `--require-signature` alone used to exit 0 UNSIGNED — the flag was only
  // read inside the signing path, which only ran under --sign. A flag that can
  // be satisfied by never running is the fail-open shape this whole artifact
  // exists to prevent, so it now IMPLIES --sign (and then fails loudly if no
  // key is available, which is the refusal it promises).
  if (args.requireSignature && !args.sign) args.sign = true;
  if (args.sign && args.stdout) {
    return { error: "--sign needs a file to write the .sig beside; --stdout has none. Drop --stdout, or drop --sign." };
  }
  if (!args.plan && !args.allRows) {
    return { error: "--plan is required: the delivery set comes from a real sync plan's ACTIONS, never from glob membership.\nIf you genuinely want every declared row (tests, fixtures), pass --all-rows explicitly." };
  }
  return args;
}

// ── the emit ────────────────────────────────────────────────────────────────

function fail(msg) {
  process.stderr.write(`emit-hook-registry: ${msg}\n`);
  process.exit(1);
}

function buildRows(args, report) {
  // 1. The registration view: settings.json EXPANDED through the registry, so
  //    rows declared in dispatch-registry.json and rows registered directly in
  //    settings.json both appear. `declared: true` returns every declared row
  //    rather than the eligibility-filtered effective view.
  let expanded;
  try {
    expanded = dispatchRegistry.readExpandedSettings(ROOT, { declared: true });
  } catch (err) {
    fail(`cannot read the expanded registration view: ${err.message}`);
  }
  const rawRows = [];
  for (const [event, groups] of Object.entries(expanded.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        const file = dispatchRegistry.hookBasename(h.command || "");
        if (!file) fail(`a ${event} registration carries a command with no .claude/hooks/<file>.js: ${JSON.stringify(h.command)}`);
        rawRows.push({
          event,
          matcher: g.matcher === undefined || g.matcher === "*" ? null : g.matcher,
          file: `${HOOKS_REL}/${file}`,
          timeout: typeof h.timeout === "number" ? h.timeout : null,
          declaredOnIncomplete: h.on_incomplete === undefined ? null : h.on_incomplete,
          declaredOnTimeout: h.on_timeout === undefined ? null : h.on_timeout,
          fromLocalRegistry: false,
        });
      }
    }
  }

  // 2. Repo-owned rows. They DO run through the dispatcher (dispatch-registry.js
  //    ::withLocal appends them per event), so they share the dispatcher's
  //    incomplete-run semantics — a distinction the first version got wrong in
  //    the fail-OPEN direction, emitting "continue" for a local row that
  //    omitted on_incomplete while the dispatcher would read the same missing
  //    value as "deny".
  if (args.localRegistry) {
    const local = readJsonIfPresent(args.localRegistry);
    if (!local) fail(`--local-registry ${args.localRegistry} is unreadable or not JSON`);
    for (const [event, spec] of Object.entries(local.events || {})) {
      for (const g of (spec && spec.groups) || []) {
        for (const h of g.hooks || []) {
          const file = dispatchRegistry.hookBasename(h.command || "");
          if (!file) continue;
          if (h.source !== undefined && h.source !== "third-party") {
            fail(`local registry row for ${file} declares source ${JSON.stringify(h.source)} — a local registry may only declare "third-party" (its rows are otherwise recorded as "repo-local")`);
          }
          rawRows.push({
            event,
            matcher: g.matcher === undefined || g.matcher === "*" ? null : g.matcher,
            file: `${HOOKS_REL}/${file}`,
            timeout: typeof h.timeout === "number" ? h.timeout : null,
            declaredOnIncomplete: h.on_incomplete === undefined ? null : h.on_incomplete,
            declaredOnTimeout: h.on_timeout === undefined ? null : h.on_timeout,
            mode: typeof h.mode === "string" ? h.mode : null,
            fromLocalRegistry: true,
            thirdParty: h.source === "third-party",
          });
        }
      }
    }
  }

  for (const r of rawRows) {
    if (!contract.EVENT_ORDER.includes(r.event)) {
      fail(`event ${r.event} is not in the contract's event set (${contract.EVENT_ORDER.join(", ")}) — the manifest cannot state what an answer at that event means, and guessing "continue" is the fail-open direction`);
    }
    if (r.matcher === "") {
      fail(`${r.file} (${r.event}): an EMPTY matcher string is refused — null is the event-wide form, and an empty string would collide with it in the id derivation while meaning something else to a consumer`);
    }
  }

  // 3. Which rows run THROUGH the dispatcher: the registry's own rows plus the
  //    local registry's (withLocal). A hook settings.json registers DIRECTLY
  //    (its own command, no dispatcher) is the only kind that is not.
  const dispatchReg = readJsonIfPresent(path.join(ROOT, HOOKS_REL, "dispatch-registry.json"));
  const dispatchedKeys = new Set();
  for (const [event, spec] of Object.entries((dispatchReg && dispatchReg.events) || {})) {
    for (const g of spec.groups || []) {
      for (const h of g.hooks || []) {
        const file = dispatchRegistry.hookBasename(h.command || "");
        if (file) dispatchedKeys.add(`${event}\u0000${g.matcher === undefined || g.matcher === "*" ? "" : g.matcher}\u0000${file}`);
      }
    }
  }
  for (const r of rawRows) {
    r.dispatched =
      r.fromLocalRegistry || dispatchedKeys.has(`${r.event}\u0000${r.matcher === null ? "" : r.matcher}\u0000${path.basename(r.file)}`);
  }
  report.dispatched_rows = rawRows.filter((r) => r.dispatched).length;
  report.host_run_rows = rawRows.filter((r) => !r.dispatched).length;

  // 4. Delivery filter — PLAN ACTIONS, and only for loom's OWN rows.
  let deliver = null;
  if (!args.allRows) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(args.plan, "utf8"));
    } catch (err) {
      fail(`--plan ${args.plan} is unreadable or not JSON: ${err.message}`);
    }
    const p = plan.plan || plan;
    if (!Array.isArray(p.files)) fail(`--plan ${args.plan} carries no plan.files[] action list`);
    if (p.target && p.target !== args.target) {
      fail(`--plan was built for target ${p.target} but --target is ${args.target} — refusing to describe a different target's delivery`);
    }
    const lane = args.lane || (p.mode === "build" || p.mode === "use" ? p.mode : null);
    if (lane && p.mode && p.mode !== lane) fail(`--plan mode is ${p.mode} but --lane is ${lane}`);
    args.lane = lane || "build";
    // Case-insensitive: a delivery-set lookup that misses on case DROPS a row,
    // and a dropped row is a guard that silently never runs.
    deliver = new Set(p.files.filter((f) => f.action === "copy").map((f) => f.path.toLowerCase()));
    report.delivery = { mode: p.mode || null, target: p.target || null, copied: deliver.size };
  } else {
    report.delivery = { mode: "all-rows", target: args.target, copied: null };
  }
  const delivered = (rel) => deliver === null || deliver.has(rel.toLowerCase());

  const kept = rawRows.filter((r) => r.fromLocalRegistry || delivered(r.file));
  const dropped = rawRows.filter((r) => !r.fromLocalRegistry && !delivered(r.file));

  // 5. Rows → contract rows. One file is read ONCE and every derived field
  //    comes off that single read, so two rows over one file cannot disagree —
  //    including the @hook-contract block, which is parsed FROM THE SAME TEXT
  //    (an earlier version re-read the path and could take the declaration from
  //    a different revision than the bytes file_sha256 pins).
  const perFile = new Map();
  const hostRunFailOpen = [];
  const docExemptions = [];
  const surfaces = deriveSurfaces(args.allowMissingSurface);
  const orderCounter = new Map();
  const rows = [];
  report.surface_notes = surfaces.notes;
  report.surfaces_absent_allowed = surfaces.absent;
  for (const r of kept) {
    const source = r.thirdParty ? "third-party" : r.fromLocalRegistry ? "repo-local" : null;
    // Keyed by (file, source class): two rows over one file with DIFFERENT
    // sources must not share a cache entry — the sidecar lookup is only legal
    // for a third-party row, and ordering hid that today.
    const cacheKey = `${r.file}\u0000${r.thirdParty ? "third-party" : r.fromLocalRegistry ? "repo-local" : "loom-template"}`;
    let cached = perFile.get(cacheKey);
    if (!cached) {
      const abs = path.join(ROOT, r.file);
      if (!fs.existsSync(abs)) {
        fail(`row for ${r.file} but no such file in this tree — a row a consumer cannot verify must never be emitted`);
      }
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        fail(`${r.file} is a SYMLINK — a hook a consumer verifies by content hash must be an ordinary file, or the bytes it reads can be redirected after the manifest is signed`);
      }
      // RAW BYTES: file_sha256 must be the hash of what is on disk, not of a
      // UTF-8 decode/re-encode (which differs for invalid UTF-8).
      const bytes = fs.readFileSync(abs);
      const src = bytes.toString("utf8");
      const parsed = contract.parseContractBlockFromText(src);
      let block = parsed.block;
      let blockErrors = parsed.ok ? contract.validateContractBlock(block, r.file) : [`${r.file}: ${parsed.error}`];
      const sidecar = `${abs}.contract.json`;
      const superseded = blockErrors.slice();
      if (blockErrors.length && fs.existsSync(sidecar)) {
        // The sidecar form is for THIRD-PARTY hooks only: a hook loom cannot
        // edit would lose an in-file block on its next update, and the
        // declaration would silently become a lie.
        if (!r.thirdParty) {
          fail(`${r.file}: ${path.basename(sidecar)} is present but the row's source is "${source || "loom-template"}" — the sidecar form is reserved for third-party hooks loom cannot edit; put the @hook-contract block in the file`);
        }
        // A sidecar that carries the row's declaration must itself be a
        // DELIVERED file: a declaration that stays behind while the hook it
        // describes ships is a row the consumer can execute but not verify.
        if (deliver !== null && !deliver.has(`${r.file}.contract.json`.toLowerCase())) {
          fail(`${r.file}: the declaration comes from ${path.basename(sidecar)}, which this lane's plan does NOT deliver — a sidecar that does not travel with its hook leaves the row unverifiable downstream. Add it to the delivery set, or move the declaration into the hook.`);
        }
        try {
          block = JSON.parse(fs.readFileSync(sidecar, "utf8"));
          blockErrors = contract.validateContractBlock(block, path.basename(sidecar));
        } catch (err) {
          fail(`${path.basename(sidecar)} is not valid JSON: ${err.message}`);
        }
      }
      const closure = contract.localRequireClosure(ROOT, r.file);
      cached = { file: r.file, src, sha256: contract.sha256Bytes(bytes), block, blockErrors, superseded: blockErrors.length ? [] : superseded, sidecar: fs.existsSync(sidecar) && r.thirdParty, closure };
      perFile.set(cacheKey, cached);
    }
    const { src, sha256, block, blockErrors, closure } = cached;

    // A sidecar that WINS reports the in-file errors it superseded — a hidden
    // second declaration is exactly the kind of thing a reader must see.
    if (cached.superseded && cached.superseded.length && cached.sidecar) {
      report.superseded_block_errors = report.superseded_block_errors || [];
      report.superseded_block_errors.push(`${r.file}: ${cached.superseded.join(" | ")}`);
    }

    if (blockErrors.length) {
      blockErrors.forEach((e) => process.stderr.write(`emit-hook-registry: ${e}\n`));
      fail(`${r.file}: @hook-contract missing or malformed (see the errors above) — every emitted row must carry one; see .claude/audit-fixtures/hook-registry/AUTHORING.md`);
    }

    const caps = lexedCapabilities(src);
    if (!caps.ok) fail(`${r.file}: cannot lex the source (${caps.error}) — every derived field would be a guess`);
    if (block.side_effects.spawns.length === 0 && (caps.spawns || requiresChildProcess(src))) {
      fail(`${r.file}: declares spawns:[] but its source calls a process-spawning primitive or requires child_process — the declaration contradicts the code it describes (a renamed binding still requires the module)`);
    }
    if (block.side_effects.fs_writes.length === 0 && caps.writes) {
      fail(`${r.file}: declares fs_writes:[] but its source calls a filesystem write primitive — declare the target (shape-only entries are fine)`);
    }
    if (!block.side_effects.network && caps.network) {
      fail(`${r.file}: declares network:false but its source opens a network connection`);
    }
    if (!block.may_rewrite_input && caps.updatedInput) {
      fail(`${r.file}: declares may_rewrite_input:false but its source references updatedInput — an UNDECLARED rewrite makes the row incomplete and a deny-class row would then deny; declare it`);
    }
    // DYNAMIC REQUIRES ARE CHECKED INDEPENDENT OF `ok`. The walker reports a
    // dynamic site as a RECORDED fact, not a failure, so an `ok` check alone
    // let `require(path.join(__dirname, …))` — the dominant form in this repo —
    // fall through with the closure silently short. A closure that is short is
    // worse than one that refuses: it verifies clean over reachable code.
    if (closure.dynamic.length) {
      const exempt = closure.dynamic.every(
        (d) =>
          DYNAMIC_REQUIRE_EXEMPTIONS.some((e) => e.file === d.file && e.line === d.line) ||
          args.dynamicExempt.has(`${d.file}:${d.line}`),
      );
      if (!exempt) {
        fail(
          `${r.file}: a load is not statically resolvable (${closure.dynamic.map((d) => describeDynamicSite(d)).join(", ")}) — the deps closure would be INCOMPLETE, so it is refused rather than emitted short. ` +
            `Exempt ONE site with --dynamic-require-exempt <file>:<line> (copy the token above), or make the specifier literal, or add a site entry to DYNAMIC_REQUIRE_EXEMPTIONS in ${EMITTER_REL}. ` +
            `Make the specifier a literal, a path.join(__dirname, …) with string parts, or a spawn script path built the same way.`,
        );
      }
    }
    if (!closure.ok) fail(`${r.file}: ${closure.error}`);

    const formFromExport = exportsHookMain(src);
    const form = r.mode === "process" ? "legacy" : formFromExport === null ? "legacy" : formFromExport ? "in-process" : "legacy";
    const rowSurfaces = surfacesFor(r.event, path.basename(r.file), surfaces);
    if (closure.dynamic.length) {
      report.dynamic_require_exemptions = report.dynamic_require_exemptions || [];
      closure.dynamic.forEach((d) => {
        // MATCHED ON (file, line): a file-keyed exemption would cover every
        // FUTURE dynamic require in the most important runtime file, and the
        // site is what the coverage argument is actually about.
        const constant = DYNAMIC_REQUIRE_EXEMPTIONS.find((e) => e.file === d.file && e.line === d.line);
        if (constant) {
          report.dynamic_require_exemptions.push(`${d.file}:${d.line} (declared: ${constant.shape})`);
          docExemptions.push({ file: d.file, line: d.line, reason: constant.reason });
        } else if (args.dynamicExempt.has(`${d.file}:${d.line}`)) {
          report.dynamic_require_exemptions.push(`${d.file}:${d.line} (CLI-declared exemption)`);
          docExemptions.push({
            file: d.file,
            line: d.line,
            reason:
              "CLI-declared exemption (--dynamic-require-exempt) — a per-run decision, carried in the document so a consumer sees the hole rather than only the emitter's report",
          });
        }
        // deduped at print time: one exemption is shared by every row whose
        // closure reaches it, and 87 identical lines bury every other finding.
      });
    }
    const refusalsPre = refusalTokens(src);
    if (!refusalsPre.ok) fail(`${r.file}: cannot lex the source (${refusalsPre.error}) for the severity scan — an unlexable source must not fall back to "advise"`);
    const onIncomplete = resolveOnIncomplete(r, refusalsPre.hits.length > 0, report);
    const onTimeout = resolveOnTimeout(r, block, onIncomplete, report);
    const order = (orderCounter.get(r.event) || 0) + 1;
    orderCounter.set(r.event, order);
    const severity = refusalsPre.hits.length > 0 && !contract.ADVISORY_ONLY_EVENTS.includes(r.event) ? "block" : "advise";
    if (r.dispatched === false && severity === "block" && onIncomplete !== "deny") {
      hostRunFailOpen.push(`${r.event} ${r.file}`);
    }

    const exitShape = exitCodeShape(src);
    const payloadStdin = {};
    for (const s of rowSurfaces) payloadStdin[s] = contract.PAYLOAD_DIALECT_BY_SURFACE[s];
    const fileSource = source || (matchesTemplateBlob(r.file, args._sourceSha) ? "loom-template" : "repo-local");

    rows.push({
      event: r.event,
      matcher: r.matcher,
      file: r.file,
      file_sha256: sha256,
      id: contract.rowId(r.event, r.matcher, r.file),
      order,
      on_incomplete: onIncomplete,
      on_crash: onIncomplete === null ? null : onIncomplete,
      on_timeout: onTimeout.value,
      ...(onTimeout.exemption ? { timeout_exemption: onTimeout.exemption } : {}),
      timeout: r.timeout,
      source: fileSource,
      pool: contract.POOL_BY_SOURCE[fileSource],
      surfaces: rowSurfaces,
      deps: closure.ok ? closure.files : [],
      contract: {
        payload_stdin: payloadStdin,
        protocol: {
          kind: contract.PROTOCOL_KIND_BY_EVENT[r.event],
          exit_codes: exitShape.literal,
          exit_codes_computed: exitShape.computed,
          decision_fields: decisionFields(src),
          severity,
        },
        form,
        runtime: form === "in-process" && rowSurfaces.includes("claude") ? "hook-engine-worker" : "node-subprocess",
        cwd_scope: readsProcessCwd(src) ? "process" : "payload",
        side_effects: {
          fs_writes: block.side_effects.fs_writes,
          network: block.side_effects.network,
          spawns: block.side_effects.spawns,
          declared_by: contract.DECLARED_BY,
        },
        idempotent: block.idempotent,
        may_rewrite_input: block.may_rewrite_input,
        ...(block.cost ? { cost: block.cost } : {}),
      },
    });
  }

  const eventRank = new Map(contract.EVENT_ORDER.map((e, i) => [e, i]));
  rows.sort((a, b) => eventRank.get(a.event) - eventRank.get(b.event) || a.order - b.order || (a.id < b.id ? -1 : 1));
  // (event, order) MUST be unique in the OUTPUT; a tie is refused here rather
  // than left for a consumer to resolve.
  const seenOrder = new Set();
  for (const row of rows) {
    const key = `${row.event}\u0000${row.order}`;
    if (seenOrder.has(key)) fail(`two rows share (event=${row.event}, order=${row.order}) — the emitter must never emit a tie; this is a bug in the ordering pass, not in the repo`);
    seenOrder.add(key);
  }

  report.rows = rows.length;
  report.files = new Set([...perFile.values()].map((v) => v.file)).size;
  report.dropped_rows = dropped.length;
  report.dropped_files = new Set(dropped.map((r) => r.file)).size;
  report.undelivered = [...new Set(dropped.map((r) => r.file))].sort();
  report.surfaces = { codex_named: surfaces.codexNamed.size, gemini_named: surfaces.geminiNamed.size, codex_handlers: surfaces.handlers.files.size };
  report.sidecar_declarations = [...perFile.values()].filter((v) => v.sidecar).length;
  report.host_run_fail_open_rows = hostRunFailOpen;
  report.deps_edges = rows.reduce((n, r) => n + r.deps.length, 0);
  if (rows.length === 0) fail("the emit resolved ZERO rows — an empty registry and a registry whose rows were all dropped are indistinguishable to a consumer, and the second is a silent total loss of coverage");
  return { rows, docExemptions };
}

/**
 * The row's incomplete-run contract.
 *
 * A row that declares nothing emits null ONLY where the manifest default and
 * the DISPATCHER's own fail-closed default agree — the dispatcher reads a
 * missing on_incomplete as `deny` at EVERY event (dispatch-registry.js::
 * onIncompleteOf), while the manifest default map says `continue` outside
 * PreToolUse, so a null emitted at, say, PostToolUse would be read two ways.
 * Undispatched rows default DENY at PreToolUse (H3): a guard that did not run
 * must not answer "allow" on the one event where it is the gate.
 */
function resolveOnIncomplete(row, denyCapable, report) {
  const declared = row.declaredOnIncomplete;
  if (declared !== null && declared !== undefined && !["deny", "continue"].includes(declared)) {
    fail(`${row.file} (${row.event}): on_incomplete is ${JSON.stringify(declared)} — the dispatcher reads an unrecognized value as "deny", so only "deny"/"continue" may be emitted`);
  }
  // H3, THE ONE POLICY OVERRIDE, and it is SURFACED rather than silent: a
  // deny-capable PreToolUse row MUST be deny/deny — a guard that can refuse
  // must not answer "allow" by failing to answer. Where the REGISTRATION
  // declares something weaker, the manifest carries the required contract and
  // the divergence is named in the report (and on stderr), because the
  // registration itself belongs to the dispatcher's own artifact — patching it
  // from here would edit another lane's handoff package.
  if (row.event === "PreToolUse" && denyCapable) {
    if (declared !== "deny") {
      report.contract_overrides = report.contract_overrides || [];
      report.contract_overrides.push(
        `${row.event} ${row.file}: registration declares on_incomplete=${JSON.stringify(declared === null || declared === undefined ? "(absent)" : declared)}, manifest emits "deny" (deny-capable PreToolUse rows are deny/deny by policy)`,
      );
    }
    return "deny";
  }
  if (declared !== null && declared !== undefined) return declared;
  if (!row.dispatched) {
    // A DIRECT registration is run by the host, not the dispatcher, so the
    // dispatcher's deny-on-incomplete policy cannot reach it and the HOST's
    // behaviour is the truth: a crash or cancel contributes nothing and
    // (outside PreToolUse) the call proceeds. At PreToolUse the seat's ruling
    // is explicit — an undispatched row defaults DENY, because that is the one
    // event where the row IS the gate.
    return row.event === "PreToolUse" ? "deny" : "continue";
  }
  const manifestDefault = contract.EVENT_DEFAULTS[row.event];
  // The dispatcher's own default, imported from the contract rather than spelled
  // here: two literals for one contract is how the emitter and the validator
  // come to disagree about what a null means.
  const dispatcherDefault = contract.DISPATCHER_ON_INCOMPLETE_DEFAULT;
  if (manifestDefault !== dispatcherDefault) {
    fail(
      `${row.file} (${row.event}): no on_incomplete declared, and emitting null would be read as ${JSON.stringify(manifestDefault)} by the manifest default map but ${JSON.stringify(dispatcherDefault)} by the dispatcher. Declare it explicitly.`,
    );
  }
  return null;
}

/**
 * on_timeout is the row's own contract unless the row declares otherwise; a
 * WEAKER timeout is legal only with a declared `timeout_exemption`, which the
 * validator surfaces so an operator sees every place a guard can time out into
 * a weaker answer.
 */
function resolveOnTimeout(row, block, onIncomplete, report) {
  const declared = row.declaredOnTimeout;
  const effective = declared !== null && declared !== undefined ? declared : onIncomplete === null ? "deny" : onIncomplete;
  const weaker = onIncomplete !== null && effective !== onIncomplete && onIncomplete === "deny";
  if (weaker) {
    if (!block.timeout_exemption) {
      fail(`${row.file} (${row.event}): on_timeout ${JSON.stringify(effective)} is WEAKER than on_incomplete ${JSON.stringify(onIncomplete)} without a declared timeout_exemption {reason} — declare why the weaker timeout is safe, or make it agree`);
    }
    report.timeout_exemptions = report.timeout_exemptions || [];
    report.timeout_exemptions.push(`${row.event} ${row.file}: ${block.timeout_exemption.reason}`);
  }
  return { value: effective, exemption: weaker ? block.timeout_exemption : null };
}

/** Manifest-level runtime pins: the adapter closures, same walker as the rows. */
function runtimePins() {
  const out = [];
  for (const entry of contract.RUNTIME_ENTRIES) {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) {
      fail(`${entry} is missing — the runtime entries are pinned by design (a hook's verdict is only as trustworthy as the adapter that produces it). Restore it, or the emit is describing a tree that cannot run these rows.`);
    }
    // THE SAME SYMLINK REFUSAL THE ROWS GET, one level up: a runtime entry is
    // what the consumer's verification of EVERY row depends on, so a path whose
    // bytes can be redirected after the manifest is signed is the worse place
    // for that hole, not a lesser one. (The row check has existed since 29; the
    // runtime pin checked existence only.)
    if (fs.lstatSync(abs).isSymbolicLink()) {
      fail(`${entry} is a SYMLINK — a runtime entry a consumer verifies by content hash must be an ordinary file, or the bytes it reads can be redirected after the manifest is signed`);
    }
    const bytes = fs.readFileSync(abs);
    const closure = contract.localRequireClosure(ROOT, entry);
    if (!closure.ok) fail(`runtime ${entry}: ${closure.error}`);
    // A runtime closure is not exempt from the row policy because it is
    // manifest-level: an unresolvable load there is the SAME hole, one level up.
    // An un-exempted dynamic site REFUSES the emit; declared ones are carried so
    // a consumer sees the hole instead of trusting there was none.
    const dynExempt = [];
    for (const d of closure.dynamic) {
      const constant = DYNAMIC_REQUIRE_EXEMPTIONS.find((e) => e.file === d.file && e.line === d.line);
      if (constant) {
        dynExempt.push({ file: d.file, line: d.line, reason: constant.reason });
        continue;
      }
      if (args.dynamicExempt.has(`${d.file}:${d.line}`)) {
        dynExempt.push({ file: d.file, line: d.line, reason: "CLI-declared exemption (--dynamic-require-exempt)" });
        continue;
      }
      fail(
        `runtime ${entry}: a load in ${describeDynamicSite(d)} is not statically resolvable and has no exemption — the runtime pin would be incomplete, so it is refused rather than emitted short. Exempt the SITE with --dynamic-require-exempt <file>:<line>, or make it literal.`,
      );
    }
    out.push({
      entry,
      entry_sha256: contract.sha256Bytes(bytes),
      deps: closure.files,
      ...(dynExempt.length ? { dynamic_require_exemptions: dynExempt } : {}),
    });
  }
  return out;
}

/** Is canon identity config present? Armed here, INERT at a consumer. */
function canonIdentityConfigPresent() {
  try {
    fs.accessSync(path.join(EMITTER_ROOT, ".claude", "canon-identity-values.json"), fs.constants.F_OK);
    return true;
  } catch (err) {
    return !(err && err.code === "ENOENT");
  }
}

/**
 * THE SHARED IDENTITY GATE over what this emits. The written
 * `.claude/hook-registry.json` is a DELIVERED surface, so it is scanned for
 * private org identity exactly as emit.mjs scans its root baselines. ARMED BY
 * CONFIG: present-but-empty REFUSES, and with no config at all the scan is
 * vacuous by design (the F6 role split).
 */
function assertHookRegistryIdentityClean(outDir, outPath) {
  const configPresent = canonIdentityConfigPresent();
  const slugs = configPresent ? assertPrivateOrgConfig() : emitPrivateOrgSlugs();
  assertTreeFreeOfPrivateIdentity(outDir, {
    slugs,
    onlyPaths: [outPath],
    label: `emit-hook-registry.mjs ${path.basename(outPath)}`,
  });
  return { inert: !configPresent };
}

function emit(args) {
  const report = { emitter: EMITTER_REL, target: args.target };
  const sourceSha = args.sourceSha || headSha();
  if (!sourceSha) fail("cannot determine source_sha: git rev-parse HEAD failed and no --source-sha was given");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail(`source_sha ${JSON.stringify(sourceSha)} is not a 40-hex commit sha`);
  report.source_sha = sourceSha;
  args._sourceSha = sourceSha;

  const { rows, docExemptions } = buildRows(args, report);
  const fileShas = Object.fromEntries(rows.map((r) => [r.file, r.file_sha256]));

  const drift = sourceDrift(fileShas, sourceSha);
  report.source_drift = { checked: drift.checked, files: drift.drifted, reason: drift.reason };
  // LOUD WHEN THE SOURCE CANNOT BE VERIFIED AT ALL. `source`/`pool` are derived
  // by comparing each hook's bytes with its blob at source_sha; when the commit
  // is unresolvable — an EXPORTED tree with no `.git`, a shallow clone, a
  // worktree whose objects are gone — that comparison cannot run, EVERY row
  // falls to `repo-local`/`pool repo`, and the template/repo split a two-pool
  // consumer relies on silently degrades. The verdict is still safe (the pins
  // are real bytes), but the DEGRADATION must not be discoverable only by
  // reading the --json report.
  if (!drift.checked) {
    process.stderr.write(
      `emit-hook-registry: WARNING — source_sha ${sourceSha} could not be resolved (${drift.reason}), so the template/repo split could NOT be derived: every row is labelled source "repo-local" / pool "repo". ` +
        `The per-row file_sha256 pins are unaffected. If this tree is an EXPORT (no .git), that is expected and permanent for this tree; a repo carrying its source commit derives the split normally.\n`,
    );
  }
  if (drift.checked && drift.drifted.length) {
    const shown = drift.drifted.slice(0, 10);
    process.stderr.write(
      `emit-hook-registry: WARNING — ${drift.drifted.length} emitted hook file(s) differ from their blob at source_sha ${sourceSha}:\n` +
        shown.map((f) => `  - ${f}\n`).join("") +
        (drift.drifted.length > shown.length ? `  … and ${drift.drifted.length - shown.length} more (full list in the --json report)\n` : "") +
        `Per-row file_sha256 pins the ACTUAL bytes, so consumers are unaffected; what is weaker is the PROVENANCE claim (and those rows emit source "repo-local", not "loom-template", because their bytes are not loom's). Re-emit after landing, or pass --source-sha naming the commit that does.\n`,
    );
    if (args.requireSourceMatch) fail(`--require-source-match: ${drift.drifted.length} file(s) differ from their blob at ${sourceSha}`);
  }

  const doc = {
    $id: contract.SCHEMA_ID,
    version: contract.SCHEMA_VERSION,
    content_sha256: "",
    content_sha256_scheme: "RFC 8785 JCS",
    source_sha: sourceSha,
    generated_by: contract.GENERATED_BY,
    unknown_major_policy: contract.UNKNOWN_MAJOR_POLICY,
    default_on_incomplete: { ...contract.EVENT_DEFAULTS },
    precedence: contract.PRECEDENCE,
    // DEDUPED BY SITE: one exemption is reached by every row whose closure
    // passes through it, so the raw list carried 86 identical entries for
    // hook-engine.js in the sample. A hole is a SITE, and the document should
    // list holes.
    ...(docExemptions.length
      ? {
          dynamic_require_exemptions: [...new Map(docExemptions.map((e) => [`${e.file}:${e.line}`, e])).values()],
        }
      : {}),
    runtimes: runtimePins(),
    hooks: rows,
  };
  try {
    doc.content_sha256 = contract.contentSha256(doc);
  } catch (err) {
    // RFC 8785 refuses what it cannot represent (a float, an unsafe integer).
    // That is a DENIAL about the document — "the checker broke" is the reading
    // this turns it away from, and it also precedes the self-check below.
    fail(`the document cannot be canonicalized, so it cannot be hashed: ${err.message}`);
  }

  // SERIALIZED BEFORE THE SELF-CHECK, because the strict half of the validator
  // runs on TEXT: a duplicate key exists only in the bytes, and a document
  // cannot be checked for one after JSON.parse has already collapsed it.
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  // The emitted text is passed IN so the validator's strict checks (duplicate
  // keys, lone surrogates, non-integers) run on the bytes this emitter is about
  // to write — not only on a caller-parsed object where JSON.parse already
  // collapsed exactly the defects the strict path exists to catch.
  const { valid, errors, warnings } = contract.validateManifest(doc, { text });
  if (!valid) {
    errors.forEach((e) => process.stderr.write(`emit-hook-registry: self-check FAILED ${e}\n`));
    fail("the emitted document does not validate against its own schema — refusing to write it");
  }
  warnings.forEach((w) => process.stderr.write(`emit-hook-registry: warn: ${w}\n`));

  report.content_sha256 = doc.content_sha256;
  report.bytes = Buffer.byteLength(text, "utf8");

  if (args.check) {
    // BYTES, not decoded text: every pin in this document moved to raw bytes,
    // and a text comparison hides a BOM or an invalid-UTF-8 byte behind a
    // lossy decode that maps both sides to the same string.
    let existing;
    try {
      existing = fs.readFileSync(args.check);
    } catch (err) {
      fail(`--check ${args.check} is unreadable: ${err.message}`);
    }
    const emitted = Buffer.from(text, "utf8");
    if (!existing.equals(emitted)) {
      fail(`--check MISMATCH: ${args.check} is not the byte-identical re-emit of this tree (emitted ${emitted.length} bytes, file is ${existing.length})`);
    }
    report.check = "match";
  }

  const outPath = args.out || path.join(ROOT, contract.MANIFEST_REL);
  if (args.stdout) process.stdout.write(text);
  else if (args.check && !args.out) {
    // --check alone must not rewrite the artifact it just verified.
    report.wrote = null;
  } else {
    writeTextArtifactSync(outPath, text);
    // GATE BEFORE THE PATH IS REPORTED AS WRITTEN, and CLEAN UP ON REFUSAL: the
    // scan runs over the bytes just written, and a hit removes them rather than
    // leaving a tainted delivered surface behind for the next sync to carry.
    let gate;
    try {
      gate = assertHookRegistryIdentityClean(path.dirname(outPath), outPath);
    } catch (err) {
      fs.rmSync(outPath, { force: true });
      fail(`identity gate REFUSED the emitted manifest (removed from ${outPath}): ${err && err.message ? err.message : err}`);
    }
    if (gate.inert) report.identity_gate = "inert (no canon identity config)";
  }
  report.manifest_path = args.stdout ? null : outPath;

  if (args.sign && !args.stdout) {
    const sig = signManifest(doc, args, outPath);
    if (sig) report.signature = sig;
  }

  if (args.json) process.stderr.write(`${JSON.stringify(report)}\n`);
  else {
    process.stderr.write(
      `emit-hook-registry: ${rows.length} rows over ${report.files} hook files` +
        (report.delivery.copied === null ? " (ALL ROWS — no delivery filter)" : ` (${report.dropped_rows} rows / ${report.dropped_files} files dropped as undelivered on ${report.delivery.mode} ${report.delivery.target})`) +
        ` · ${report.deps_edges} dep edges · content_sha256=${doc.content_sha256.slice(0, 16)}… · source_sha=${sourceSha}\n`,
    );
    if (report.surface_notes.length) report.surface_notes.forEach((n) => process.stderr.write(`emit-hook-registry: note: ${n}\n`));
    if (report.superseded_block_errors) report.superseded_block_errors.forEach((n) => process.stderr.write(`emit-hook-registry: note: sidecar won over in-file block — ${n}\n`));
    if (report.timeout_exemptions) report.timeout_exemptions.forEach((n) => process.stderr.write(`emit-hook-registry: SURFACED timeout exemption — ${n}\n`));
    if (report.contract_overrides) report.contract_overrides.forEach((n) => process.stderr.write(`emit-hook-registry: CONTRACT OVERRIDE (registration weaker than policy) — ${n}\n`));
    if (report.dynamic_require_exemptions) [...new Set(report.dynamic_require_exemptions)].forEach((n) => process.stderr.write(`emit-hook-registry: SURFACED dynamic-require exemption — ${n}\n`));
    if (report.host_run_fail_open_rows.length) {
      process.stderr.write(
        `emit-hook-registry: ${report.host_run_fail_open_rows.length} row(s) CAN REFUSE but are registered DIRECTLY in settings.json, so the dispatcher's deny-on-incomplete policy cannot reach them and the host proceeds when they crash or are cancelled:\n` +
          report.host_run_fail_open_rows.map((r) => `  - ${r}\n`).join(""),
      );
    }
  }
  return 0;
}

/**
 * The sibling signature. Signed payload is {content_sha256, source_sha,
 * version} — NOT the whole document: the document is already covered by
 * content_sha256, so signing the triple binds identity + provenance + scheme
 * without re-signing a megabyte on every emit. Serialized with coc-sign's
 * `canonicalSerialize` (the frozen loom↔csq seam serializer), so the verifier
 * on the other side has ONE function to call.
 */
function signManifest(doc, args, outPath) {
  const payload = { content_sha256: doc.content_sha256, source_sha: doc.source_sha, version: doc.version };
  const serialized = cocSign.canonicalSerialize(payload);
  const res = cocSign.sign(serialized, args.signKey ? { keyType: args.signKeyType, keyPath: args.signKey } : {});
  if (!res || res.ok !== true) {
    const reason = (res && (res.reason || res.error)) || "unknown";
    if (args.requireSignature) fail(`--require-signature: the signing path is unavailable: ${reason}`);
    process.stderr.write(
      `emit-hook-registry: NOTE — no signature written: the signing path is unavailable (${reason}). The manifest is still emitted; a consumer that pins authenticity fails closed on a missing .sig, which is the intended behaviour. Pass --sign-key <path> (see the README for the verification side).\n`,
    );
    return null;
  }
  const sigPath = `${outPath}.sig`;
  const body = {
    scheme: SIG_SCHEME,
    signed_payload: payload,
    serializer: "coc-sign.canonicalSerialize",
    key_type: res.keyType || args.signKeyType,
    signature: res.sig,
  };
  writeTextArtifactSync(sigPath, `${JSON.stringify(body, null, 2)}\n`);
  return { path: sigPath, scheme: SIG_SCHEME, key_type: body.key_type };
}

const args = parseArgs(process.argv);
if (args.help) {
  usage();
  process.exit(0);
}
if (args.error) process.exit(usage(args.error));
if (args.root) {
  ROOT = path.resolve(args.root);
  if (!fs.existsSync(path.join(ROOT, ".claude", "hooks"))) {
    process.exit(usage(`--root ${ROOT} carries no .claude/hooks tree — it is not a repo this contract can describe`));
  }
}
try {
  process.exit(emit(args));
} catch (err) {
  process.stderr.write(`emit-hook-registry: internal error (nothing was written): ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
}
