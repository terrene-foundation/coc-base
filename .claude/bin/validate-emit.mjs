#!/usr/bin/env node
/*
 * ============================================================================
 *  Pre-Emit Validator — F30 (issue #350 Stage 2)
 * ============================================================================
 *
 *  loom is its own L5_DELEGATED consumer of its own rule corpus. It authors
 *  the rules that downstream `/redteam` enforces via mechanical sweep, but it
 *  did not run those sweeps against its OWN emit output before `/sync`
 *  distributed it — so each downstream Round-1 sweep re-derived the same class
 *  of gap, filed an issue, loom patched, repeat (issue #350's 7-finding
 *  cluster). This validator closes the class: it runs the rule-corpus
 *  mechanical sweeps against loom's emit surface at `/sync` time and BLOCKS on
 *  any violation, turning each downstream sweep into an asserted invariant at
 *  loom emit time.
 *
 *  Value-anchor (value-prioritization.md MUST-1 source e — user-filed/approved
 *  spec): issue #350 § "Acceptance criteria" — "tools/validate-emit.* scaffold
 *  lands with the 7 first-cycle checks ... /sync blocks on any check fail
 *  unless --allow=<check-name>:<path> ... validator itself follows
 *  probe-driven-verification.md (each check is structural)".
 *
 *  THE CHECKS (1-7 map 1:1 to issue #350 Findings 1-7; 8 added F104):
 *    1. command-frontmatter        every .claude/commands/*.md opens with `---`
 *                                  (or is in COMMAND_FRONTMATTER_EXEMPT)
 *    2. command-line-cap           command body (after frontmatter) <= 150 lines
 *    3. readonly-specialist-tools  agents named read-only in agents.md MUST NOT
 *                                  declare file-mutation tools (Edit/Write).
 *                                  Bash + Task are allowed — reviewer's mechanical
 *                                  sweeps need Bash, Task is sub-delegation.
 *    4. tool-canonicality          every agent `tools:` value is a canonical CC tool
 *    5. mirror-exclusion           every source SKILL is emitted to each CLI tree
 *                                  (fresh emit) OR is in cli_emit_exclusions
 *                                  (v1 scopes to skills — Finding 7's category;
 *                                  command/agent mirror needs emitter-side
 *                                  reconciliation, tracked as the check-5 follow-up)
 *    6. paths-annotation-consistency  a rule annotated with a path glob in the
 *                                  emitted CLAUDE/AGENTS/GEMINI Rules Index MUST
 *                                  carry that glob in its `paths:` frontmatter
 *    7. audit-fixture-coverage     every `detect*` detector in violation-patterns.js
 *                                  has an audit-fixture dir with >=1 flag + >=1 clean
 *    8. loom-only-mutual-exclusion (F104) a `loom_only:` glob that is ALSO in a
 *                                  synced tier FAILS (blocks /sync); a glob
 *                                  matching 0 on-disk files = WARN (non-blocking).
 *   15. variant-orphan            (todo 16) every TRACKED file under
 *                                  .claude/variants/ MUST be one of: a `variants:`
 *                                  overlay value, a `variant_only:<lang>` entry, a
 *                                  RULE/wrapper under a convention axis tree
 *                                  (variants/<axis>/rules/ · variants/<cli>/wrappers/),
 *                                  a null-ACK phantom (variants: <key> with this
 *                                  lang explicitly null), or a README/.example
 *                                  companion doc. Anything else = orphan → FAIL.
 *                                  Enumerated via `git ls-files` (untracked
 *                                  operator-local *.local.md companions are OUT of
 *                                  scope by design). The allowlist MUST union BOTH
 *                                  `variants:` AND `variant_only:` — a
 *                                  `variants:`-only reading mis-reports ~200 false
 *                                  orphans (the client-report symptom; see
 *                                  workspaces/sync-upflow/todos/active/16-*).
 *   16. allowlist-paths-coverage (#443) every named-file entry in
 *                                  self-referential-codify.md's Rule-2 allowlist
 *                                  (the firing-scope SUBSET) MUST be covered by
 *                                  ≥1 `paths:` frontmatter glob (the load-trigger
 *                                  SUPERSET). An uncovered entry means editing it
 *                                  never LOADS the rule, so the Rule-1 gate
 *                                  silently does not FIRE on it → FAIL (the #440
 *                                  `.claude/codex-mcp-guard/**` gap class).
 *
 *  Each check is STRUCTURAL (file existence, frontmatter parse, line count, set
 *  membership, glob match, tree presence) per probe-driven-verification.md
 *  MUST-3 — no regex-over-prose semantic assertion. No LLM needed.
 *
 *  STATUS per artifact:  pass | fail | fixture-needed | skip
 *    - fail            verified violation; BLOCKS /sync (exit 1) unless allowed
 *    - fixture-needed  check-7 missing-fixture finding; BLOCKS unless allowed
 *    - skip            check could not run (input absent, e.g. no staged emit
 *                      tree for check 5); informational, does NOT block
 *
 *  OVERRIDE:  --allow=<check-id>:<artifact>   (repeatable)
 *    Removes a specific (check, artifact) finding from the blocking set. The
 *    override is echoed in the report so the /sync commit message records every
 *    suppression (auditable per issue #350 acceptance criteria).
 *
 *  Usage:
 *    node .claude/bin/validate-emit.mjs [--json] [--check <id>] [--allow <id>:<path>] [--help]
 *
 *  Exit:
 *    0 = no blocking findings (all pass/skip, or every fail/fixture-needed allowed)
 *    1 = >=1 unallowed blocking finding
 *    2 = usage / IO error
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml). Zero
 *  client/org tokens; detection is purely structural.
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync, realpathSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// CJS bridge — the provenance-event schema (EVENT_KINDS, the frozen closed
// taxonomy) and coc-sign's canonicalSerialize (the byte-exact seam serializer
// csq signs against) are CommonJS hook libs. Routing both through one
// createRequire keeps check-9 (provenance-parity, F101-4 / loom#411 item 5)
// anchored on the SAME taxonomy the capture hooks use — no re-declaration drift.
const _require = createRequire(import.meta.url);
const { EVENT_KINDS } = _require("../hooks/lib/provenance-event.js");
const { canonicalSerialize } = _require("../hooks/lib/coc-sign.js");

// #392 — the unified `.coc/` emitter. Reused read-only here to surface the
// emit-breaking conditions (duplicate id §9.4.2 / grammar violation §9.2.1) at
// /sync time. emitCoc uses the loom checkout (emit-cli-artifacts.mjs::REPO);
// the check SKIPs when validate-emit is pointed at a different root.
import { emitCoc } from "./emit-coc.mjs";
import { REPO as EMIT_REPO } from "./emit-cli-artifacts.mjs";

// --- Repo root resolution -----------------------------------------------

function findRepoRoot(startDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || startDir;
  } catch {
    process.stderr.write(
      `validate-emit: warning: git rev-parse failed for cwd=${startDir}; scanning relative to cwd\n`,
    );
    return startDir;
  }
}

// --- Constants ----------------------------------------------------------

// Canonical Claude Code tool surface. `LS` is NOT in the set (issue #350
// Finding 6). `*` is the wildcard grant (the catch-all `claude` agent).
const CANONICAL_CC_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task",
  "WebSearch", "WebFetch", "Skill", "Agent", "NotebookEdit", "*",
]);

// File-MUTATION tools a read-only specialist MUST NOT declare. Per agents.md
// § "Verify Specialist Tool Inventory", implementation delegation requires a
// specialist with `Edit` AND `Bash`; "read-only" means it cannot MUTATE files
// (no Edit/Write). Bash is NOT forbidden — reviewer/security-reviewer run
// read-only mechanical sweeps (`grep -c`, `pytest --collect-only`) that need
// Bash (agents.md § "Reviewer Mechanical Sweeps"). Task is sub-delegation, not
// file mutation. So the prohibition is exactly the two mutation tools.
const READONLY_FORBIDDEN_TOOLS = new Set(["Edit", "Write"]);

const COMMAND_LINE_CAP = 150; // cc-artifacts.md Rule 3 + command-authoring SKILL

// Commands intentionally exempt from the `---` frontmatter requirement.
// Empty by default; any entry MUST be documented in command-authoring/SKILL.md.
const COMMAND_FRONTMATTER_EXEMPT = new Set([]);

// A violation-pattern detector is any export matching this shape.
const DETECTOR_RE = /^detect[A-Z]/;

const CHECK_IDS = [
  "command-frontmatter",
  "command-line-cap",
  "readonly-specialist-tools",
  "tool-canonicality",
  "mirror-exclusion",
  "paths-annotation-consistency",
  "audit-fixture-coverage",
  "loom-only-mutual-exclusion",
  "provenance-parity",
  "provenance-subagent-hooks",
  "hook-delivery",
  "coc-artifact-ids",
  "consumer-efficacy",
  "codex-policies-fresh",
  "variant-orphan",
  "allowlist-paths-coverage",
  "surface-role-membership",
];

const STATUS = {
  PASS: "pass",
  FAIL: "fail",
  FIXTURE_NEEDED: "fixture-needed",
  SKIP: "skip",
};

// A finding blocks /sync iff it is FAIL or FIXTURE_NEEDED (and not allowed).
function isBlocking(status) {
  return status === STATUS.FAIL || status === STATUS.FIXTURE_NEEDED;
}

// --- Frontmatter parsing ------------------------------------------------

// Returns { hasFrontmatter, body, fields } where fields parses the simple
// YAML subset loom artifacts use: scalar `key: value` and `key:` + `- item`
// list blocks. Only the leading `---` … `---` block is parsed.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { hasFrontmatter: false, body: text, fields: {} };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Unterminated frontmatter — treat as none (structural; the check that
    // cares about frontmatter presence will still see line[0]==='---').
    return { hasFrontmatter: true, body: text, fields: {}, unterminated: true };
  }
  const fmLines = lines.slice(1, end);
  const fields = {};
  let currentListKey = null;
  for (const raw of fmLines) {
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem && currentListKey) {
      const val = stripQuotes(listItem[1].trim());
      fields[currentListKey].push(val);
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val === "") {
        // Could be a list header OR an empty scalar. Default to list.
        fields[key] = [];
        currentListKey = key;
      } else {
        fields[key] = stripQuotes(val);
        currentListKey = null;
      }
    }
  }
  const body = lines.slice(end + 1).join("\n");
  return { hasFrontmatter: true, body, fields };
}

function stripQuotes(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// Parse a `tools:` value that may be an inline comma list (`Read, Edit`) or a
// YAML list block (parsed as array by parseFrontmatter). Returns string[].
function parseToolList(toolsField) {
  if (Array.isArray(toolsField)) return toolsField.map((t) => t.trim()).filter(Boolean);
  if (typeof toolsField === "string") {
    return toolsField
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

// --- File walkers -------------------------------------------------------

function listMarkdown(dir, depth = 0) {
  const out = [];
  // Security: bound recursion depth. A symlink-cycle is already blocked by the
  // isSymbolicLink() guard below, but a genuine on-disk deep tree (e.g. a
  // pathological skills/ layout) could still stack-overflow the walker
  // (security-reviewer R3 LOW-2 — unbounded-recursion DoS guard).
  if (depth > 20) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // Security: never follow symlinks. A symlink-cycle (e.g. `commands/loop ->
    // ..`) would otherwise wedge /sync via unbounded recursion (security-reviewer
    // R1 M1 — symlink-cycle DoS guard).
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      out.push(...listMarkdown(full, depth + 1));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function safeRead(file) {
  // Security: bound max file size at 10 MB. readFileSync on an unbounded file
  // (e.g. a multi-GB .md accidentally committed) would OOM the validator
  // (security-reviewer R3 LOW-1 — unbounded-input DoS guard). Oversize files
  // return null, matching the existing failure-mode semantics (callers treat
  // null as SKIP/error).
  try {
    const st = statSync(file);
    if (st.size > 10 * 1024 * 1024) return null;
  } catch {
    return null;
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// =======================================================================
//  CHECK 1 — command frontmatter
// =======================================================================
function checkCommandFrontmatter(root) {
  const id = "command-frontmatter";
  const dir = join(root, ".claude", "commands");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const name = basename(f);
    if (COMMAND_FRONTMATTER_EXEMPT.has(name)) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: "exempt" });
      continue;
    }
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    // reviewer R1 #4: an unterminated frontmatter (`---` open, no close) consumes
    // the entire body — the validator must fail it explicitly, not silently PASS.
    const fmCheck = parseFrontmatter(text);
    if (fmCheck.unterminated) {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: "frontmatter open '---' but no closing '---' (parseFrontmatter would consume entire body)",
      });
      continue;
    }
    const first = text.split(/\r?\n/)[0];
    if (first === "---") {
      results.push({ artifact: rel, status: STATUS.PASS });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `first line is '${first.slice(0, 40)}' — expected '---' (command-authoring SKILL frontmatter requirement)`,
      });
    }
  }
  return { id, source_rule: "command-authoring SKILL", results };
}

// =======================================================================
//  CHECK 2 — command line cap (body after frontmatter <= 150)
// =======================================================================
function checkCommandLineCap(root) {
  const id = "command-line-cap";
  const dir = join(root, ".claude", "commands");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    const { body } = parseFrontmatter(text);
    // Trailing newline produces one empty element; trim it for the count.
    const bodyLines = body.replace(/\n+$/, "").split(/\r?\n/).length;
    if (bodyLines <= COMMAND_LINE_CAP) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: `${bodyLines} body lines` });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `${bodyLines} body lines > ${COMMAND_LINE_CAP} (cc-artifacts.md Rule 3)`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md Rule 3", results };
}

// =======================================================================
//  CHECK 3 — read-only specialist tool inventory
// =======================================================================
// Parse the read-only specialist list from agents.md verbatim
// ("Read-only specialists (`a`, `b`, ...)"), then assert each named agent's
// frontmatter `tools:` declares NONE of READONLY_FORBIDDEN_TOOLS.
function parseReadonlySpecialists(root) {
  const agentsRule = safeRead(join(root, ".claude", "rules", "agents.md"));
  if (agentsRule === null) return null;
  const m = agentsRule.match(/Read-only specialists\s*\(([^)]*)\)/);
  if (!m) return null;
  const names = [];
  for (const bt of m[1].matchAll(/`([a-z0-9-]+)`/g)) names.push(bt[1]);
  return names;
}

function findAgentFile(root, name) {
  const agentsDir = join(root, ".claude", "agents");
  for (const f of listMarkdown(agentsDir)) {
    if (basename(f) === `${name}.md`) return f;
  }
  return null;
}

function checkReadonlySpecialistTools(root) {
  const id = "readonly-specialist-tools";
  const results = [];
  const names = parseReadonlySpecialists(root);
  if (names === null) {
    return {
      id,
      source_rule: "agents.md § Verify Specialist Tool Inventory",
      results: [{ artifact: "rules/agents.md", status: STATUS.SKIP, detail: "could not parse read-only specialist list" }],
    };
  }
  for (const name of names) {
    const f = findAgentFile(root, name);
    if (!f) {
      results.push({ artifact: `agents/**/${name}.md`, status: STATUS.SKIP, detail: "agent file not found" });
      continue;
    }
    const rel = relative(root, f);
    const { fields } = parseFrontmatter(safeRead(f) || "");
    const tools = parseToolList(fields.tools);
    const forbidden = tools.filter((t) => READONLY_FORBIDDEN_TOOLS.has(t));
    if (forbidden.length === 0) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: `tools: ${tools.join(", ") || "(none)"}` });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `read-only specialist '${name}' declares implementation tools: ${forbidden.join(", ")} (agents.md classifies it read-only)`,
      });
    }
  }
  return { id, source_rule: "agents.md § Verify Specialist Tool Inventory", results };
}

// =======================================================================
//  CHECK 4 — tool-name canonicality
// =======================================================================
function checkToolCanonicality(root) {
  const id = "tool-canonicality";
  const dir = join(root, ".claude", "agents");
  const results = [];
  for (const f of listMarkdown(dir)) {
    const rel = relative(root, f);
    const text = safeRead(f);
    if (text === null) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "unreadable" });
      continue;
    }
    const { fields } = parseFrontmatter(text);
    if (fields.tools === undefined) {
      results.push({ artifact: rel, status: STATUS.SKIP, detail: "no tools: frontmatter" });
      continue;
    }
    const tools = parseToolList(fields.tools);
    const bad = tools.filter((t) => !CANONICAL_CC_TOOLS.has(t));
    if (bad.length === 0) {
      results.push({ artifact: rel, status: STATUS.PASS });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail: `non-canonical tool(s): ${bad.join(", ")} — canonical set: ${[...CANONICAL_CC_TOOLS].filter((t) => t !== "*").join(", ")}`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md (canonical CC tool set)", results };
}

// =======================================================================
//  CHECK 5 — mirror + exclusion completeness
// =======================================================================
// Parse cli_emit_exclusions from sync-manifest.yaml; for each CLI {codex,
// gemini} and each source artifact under skills/agents/commands, the artifact
// is EITHER excluded (matches an exclusion glob) OR must be present in the
// staged .{cli}/ tree at its mapped path. If the staged tree is absent (no
// emit run yet) the artifact is SKIP (informational), never FAIL.
function parseEmitExclusions(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const lines = manifest.split(/\r?\n/);
  const out = { codex: [], gemini: [] };
  let inBlock = false;
  let cli = null;
  for (const raw of lines) {
    if (/^cli_emit_exclusions:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // A new top-level key (no indent, ends with `:`) ends the block.
      if (/^[A-Za-z0-9_]+:/.test(raw)) {
        inBlock = false;
        continue;
      }
      const cliHdr = raw.match(/^  ([A-Za-z0-9_]+):\s*$/);
      if (cliHdr) {
        cli = cliHdr[1];
        if (!out[cli]) out[cli] = [];
        continue;
      }
      const item = raw.match(/^\s+-\s+(.*)$/);
      if (item && cli && out[cli]) out[cli].push(item[1].trim());
    }
  }
  return out;
}

function matchesGlob(relPath, glob) {
  // Support exact match and trailing `/**` prefix match (the only forms used
  // in cli_emit_exclusions).
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(prefix + "/");
  }
  return relPath === glob;
}

// --- loom_only / tiers parsing (check 8) -------------------------------

// Parse the top-level FLAT `loom_only:` glob list (F104). Same shape as
// `obsoleted:` / `exclude:`: a top-level key whose body is `- <glob>`
// entries at 2-space indent, no nested CLI sub-keys. Returns string[] (may
// be empty) or null when the manifest is unreadable.
function parseLoomOnly(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const out = [];
  let inBlock = false;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^loom_only:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A new top-level key (no indent, ends with `:`) ends the block.
    if (/^[A-Za-z0-9_-]+:\s*$/.test(raw) && !raw.startsWith(" ")) break;
    const item = raw.match(/^ {2}-\s*(.+?)\s*$/);
    if (item) {
      const v = item[1].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// Parse the `tiers:` block into { tier: [glob, ...] }. 2-space tier key →
// 4-space `- glob` entries. Returns {} when absent / unreadable.
function parseTiers(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return {};
  const tiers = {};
  let inBlock = false;
  let cur = null;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^tiers:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^[A-Za-z0-9_-]+:\s*$/.test(raw) && !raw.startsWith(" ")) break;
    const tierHdr = raw.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (tierHdr) {
      cur = tierHdr[1];
      tiers[cur] = [];
      continue;
    }
    const item = raw.match(/^ {4}-\s*(.+?)\s*$/);
    if (item && cur) {
      const v = item[1].replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
      if (v) tiers[cur].push(v);
    }
  }
  return tiers;
}

// Does `relPath` (manifest-relative, e.g. `agents/management/coc-sync.md`)
// match `glob`? Supports exact + trailing `/**` (matchesGlob) AND a bare
// glob authored WITH a leading `.claude/` is tolerated by stripping it. The
// path-shape both stanzas use is bare (`agents/...`), so a literal compare
// suffices for the common case; `/**` handles directory-prefix tier globs.
function loomGlobMatch(relPath, glob) {
  const g = glob.startsWith(".claude/") ? glob.slice(".claude/".length) : glob;
  return matchesGlob(relPath, g);
}

// Emit a FRESH per-CLI tree via emit-cli-artifacts.mjs --out <tmp>, so the
// mirror check compares against what the emitter ACTUALLY produces — not a
// possibly-stale checked-in .codex/.gemini tree, and not a hand-rolled path
// mapping that drifts from the emitter's real layout. Returns
// { ok, dir, error }. The caller MUST rmSync(dir) when done.
function emitFresh(root) {
  const dir = mkdtempSync(join(tmpdir(), "validate-emit-"));
  try {
    execFileSync(
      "node",
      [join(root, ".claude", "bin", "emit-cli-artifacts.mjs"), "--out", dir],
      // timeout bounds a hung emitter so it cannot wedge /sync (R1 security L2,
      // same-class hardening as checkCodexPoliciesFresh).
      { cwd: root, encoding: "utf8", timeout: 60000, stdio: ["ignore", "ignore", "pipe"] },
    );
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, dir, error: e && e.stderr ? String(e.stderr) : String(e && e.message) };
  }
}

// Is source artifact `art` present in the freshly-emitted `<emitDir>/<cli>/`
// tree? Detection matches the emitter's real layout (emit-cli-artifacts.mjs):
//   skill   skills/<n>     → <cli>/skills/<n>            (dir)
//   command commands/<n>.md→ codex prompts/<n>.md | gemini commands/<n>.toml
//   agent   agents/.../<n>.md → codex prompts/* containing <n> | gemini agents/<n>.md
// Agent codex naming is emitter-decided (a promptName), so codex-agent presence
// is a stem-contains scan of the prompts/ dir — robust to the emitter's choice.
function presentInEmit(emitDir, cli, art) {
  const base = join(emitDir, cli);
  if (art.kind === "skill") {
    return existsSync(join(base, "skills", basename(art.rel)));
  }
  if (art.kind === "command") {
    const stem = basename(art.rel, ".md");
    if (cli === "codex") return existsSync(join(base, "prompts", `${stem}.md`));
    return existsSync(join(base, "commands", `${stem}.toml`));
  }
  if (art.kind === "agent") {
    const stem = basename(art.rel, ".md");
    if (cli === "gemini") return existsSync(join(base, "agents", `${stem}.md`));
    // codex: scan prompts/ for any emitted file whose name contains the stem.
    const promptsDir = join(base, "prompts");
    let entries;
    try {
      entries = readdirSync(promptsDir);
    } catch {
      return false;
    }
    return entries.some((n) => n.endsWith(".md") && n.includes(stem));
  }
  return false;
}

function collectSourceArtifacts(root) {
  // Returns manifest-relative paths for skills (dir), commands (md), agents (md).
  const arts = [];
  // skills: one entry per skill dir (presence of the dir is what's emitted)
  const skillsDir = join(root, ".claude", "skills");
  try {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue; // security-reviewer R1 M1 — no symlink follow
      if (e.isDirectory() && !e.name.startsWith(".")) {
        arts.push({ kind: "skill", rel: `skills/${e.name}` });
      }
    }
  } catch { /* no skills dir */ }
  for (const f of listMarkdown(join(root, ".claude", "commands"))) {
    const b = basename(f);
    if (b.startsWith("_")) continue; // _README etc. are not emittable artifacts
    arts.push({ kind: "command", rel: `commands/${b}` });
  }
  for (const f of listMarkdown(join(root, ".claude", "agents"))) {
    if (basename(f).startsWith("_")) continue; // _README is not an agent
    arts.push({ kind: "agent", rel: relative(join(root, ".claude"), f) });
  }
  return arts;
}

function checkMirrorExclusion(root, opts) {
  const id = "mirror-exclusion";
  const exclusions = parseEmitExclusions(root);
  const results = [];
  if (exclusions === null) {
    return {
      id,
      source_rule: "sync-manifest.yaml cli_emit_exclusions",
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  // Compare against a FRESH emit. Prefer a caller-supplied --emit-dir (the tree
  // /sync just produced); otherwise emit into a temp dir ourselves.
  let emitDir = (opts && opts.emitDir) || null;
  let ownEmit = null;
  if (!emitDir) {
    ownEmit = emitFresh(root);
    if (!ownEmit.ok) {
      // Clean up the temp dir even on the failure path (R1 cc-architect LOW-1).
      try {
        if (ownEmit.dir) rmSync(ownEmit.dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return {
        id,
        source_rule: "sync-manifest.yaml cli_emit_exclusions",
        results: [
          {
            artifact: "(emit)",
            status: STATUS.SKIP,
            detail: `could not run emit-cli-artifacts.mjs: ${(ownEmit.error || "").slice(0, 200)}`,
          },
        ],
      };
    }
    emitDir = ownEmit.dir;
  }
  try {
    // SCOPE (v1): skills only. Skills emit uniformly to `<cli>/skills/<name>`
    // for every CLI, so "mirror to all trees unless excluded" holds cleanly and
    // matches issue #350 Finding 7 (a skill drop). Commands and agents have
    // CLI-divergent emit shapes + richer structural skips (codex strips the
    // `-specialist` suffix → `specialist-<short>.md`; `_README`, architects, and
    // management agents are skipped by emitter logic, not just literal
    // cli_emit_exclusions). Re-deriving that here produces false positives; the
    // correct extension is an emitter-side `--report-json` reconciliation the
    // validator consumes (tracked as the check-5 follow-up). Management agents
    // are loom-only and never emitted.
    const arts = collectSourceArtifacts(root).filter(
      (a) => a.kind === "skill" && !a.rel.startsWith("agents/management/"),
    );
    for (const cli of ["codex", "gemini"]) {
      const excl = exclusions[cli] || [];
      for (const a of arts) {
        const tag = `${cli}:${a.rel}`;
        if (excl.some((g) => matchesGlob(a.rel, g))) {
          results.push({ artifact: tag, status: STATUS.PASS, detail: "excluded (declared)" });
          continue;
        }
        if (presentInEmit(emitDir, cli, a)) {
          results.push({ artifact: tag, status: STATUS.PASS });
        } else {
          results.push({
            artifact: tag,
            status: STATUS.FAIL,
            detail: `not emitted to ${cli} and not in cli_emit_exclusions.${cli} — undeclared drop (issue #350 Finding 7)`,
          });
        }
      }
    }
  } finally {
    if (ownEmit && ownEmit.dir) {
      try {
        rmSync(ownEmit.dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
  return { id, source_rule: "sync-manifest.yaml cli_emit_exclusions", results };
}

// =======================================================================
//  CHECK 13 — consumer-side efficacy (#408 AC#7)
// =======================================================================
// The completeness check (mirror-exclusion) proves a source artifact is
// PRESENT in the fresh emit. This check proves the freshly-emitted artifacts
// actually PARSE-LOAD under each target CLI's runtime SCHEMA contract — the
// gap that ships a tomlLiteralEscape bug, an unterminated frontmatter, or a
// body-embedded ''' silently and breaks the consumer's Codex/Gemini loader on
// first use (#408's "completed-without-consumer-verification" failure mode).
//
// loom has NO .github/workflows/ (journal/0234), so AC#7's "post-merge
// consumer smoke-runner" runs HERE — a /sync-time validate-emit check + Tier-2
// regression — not a CI job. The Codex/Gemini runtimes are not installable in
// this environment, so "parse-load under the target runtime" is implemented
// faithfully as the per-CLI loader's SCHEMA contract (TOML for Gemini commands,
// YAML frontmatter for Codex prompts + skills), not a live binary invocation.
//
// Assertions over the FRESH emit (reuses emitFresh, shares opts.emitDir with
// mirror-exclusion when /sync already produced a tree):
//   A. gemini/commands/*.toml      → valid TOML shape (name/description/prompt;
//                                     literal opened+closed; no premature ''')
//   B. codex/prompts/*.md          → terminated, well-formed YAML frontmatter
//                                     carrying a non-empty `name`
//   C. {codex,gemini}/skills/*/SKILL.md → frontmatter parses; name+description
//   D. rules-reference index integrity (the AC#5-b delivery channel): emitted
//      symmetrically on both lanes, non-empty, every cited .claude/rules/<f>.md
//      row resolves to a real source file (no dangling citation).
//
// Part D asserts index INTEGRITY (parse + non-empty + no-dangling + lane
// symmetry) — NOT a re-derivation of which rules resolve to skill-channel.
// Re-deriving lane resolution would spawn the divergent second parser the
// AC#5-a redteam closed (lib/cli-delivery.mjs is the SSOT both the emitter and
// Validator 18 import); Validator 18 already gates the source-side resolution.

// Faithful minimal validator for the emitter's Gemini-command TOML shape
// (emit-cli-artifacts.mjs::emitCommands). Returns an array of error strings
// (empty = parse-load-clean). Mirrors TOML literal-string semantics: a
// multiline literal '''…''' closes at the FIRST ''' after the opener. The
// emitter escapes EVERY ''' in the body (tomlLiteralEscape: '''→''′'), so a
// clean emit has EXACTLY ONE ''' after the opener — the closer. Zero ''' is
// unterminated; ≥2 means a body-embedded ''' (the escape-bug class) closed the
// literal early — either invalid TOML OR a silently-truncated prompt body. Both
// are efficacy failures, so the count check is stricter than (and subsumes) a
// post-close line-shape heuristic (R1 reviewer LOW-2: catches silent truncation
// where the residue coincidentally still parses as TOML).
function validateGeminiCommandToml(text) {
  const errs = [];
  if (!/^name\s*=\s*".*"\s*$/m.test(text)) errs.push('missing or malformed `name = "…"`');
  if (!/^description\s*=\s*".*"\s*$/m.test(text))
    errs.push('missing or malformed `description = "…"`');
  const open = text.match(/^prompt\s*=\s*'''[ \t]*\r?\n/m);
  if (!open) {
    errs.push("missing `prompt = '''` literal block");
    return errs;
  }
  const after = text.slice(open.index + open[0].length);
  const tripleCount = (after.match(/'''/g) || []).length;
  if (tripleCount === 0) {
    errs.push("unterminated prompt ''' literal (no closing ''')");
  } else if (tripleCount > 1) {
    errs.push(
      "body-embedded ''' closed the prompt literal early (unescaped ''' — invalid TOML or a silently-truncated prompt body)",
    );
  }
  return errs;
}

// Collect every Read-column `.claude/rules/<file>.md` citation from a
// rules-reference SKILL.md index (one per table row per emitRulesReferenceSkill,
// which wraps the canonical citation in backticks: `.claude/rules/<file>.md`).
// The backtick-delimited anchor is load-bearing on TWO axes (R1 cc-architect
// MED-2 + security LOW-2): (1) it excludes a paths-COLUMN glob that merely
// embeds `.claude/rules/...` as a substring of a longer pattern (e.g.
// `**/.claude/rules/loom-csq-boundary.md`) — only the Read-column citation has a
// backtick immediately before `.claude`; (2) `[\w.-]+` matches no path
// separator, so a captured `<file>` is always a single segment and the
// downstream `join(root, ".claude/rules", file)` existence probe cannot
// traverse out of the rules dir. De-duplicated so a rule cited once is counted
// once.
function extractRulesIndexCitations(text) {
  const cites = [...text.matchAll(/`\.claude\/rules\/([\w.-]+\.md)`/g)].map((m) => m[1]);
  return [...new Set(cites)];
}

// All SKILL.md paths (relative to `skillDir`) anywhere in a skill's tree. A
// skill is either leaf (`<skill>/SKILL.md`) or nested/multi-variant
// (`<skill>/<variant>/SKILL.md`, e.g. 40-stack-onboarding/{go,python,rust,
// typescript}/SKILL.md), so the scan recurses rather than assuming a flat
// layout. `depth` cap + symlink skip mirror the sibling `listMarkdown` walker's
// DoS guards (R1 security MED-1 — unbounded-recursion; R1 M1 — symlink-cycle).
function findSkillManifests(skillDir, base = "", depth = 0) {
  const out = [];
  if (depth > 20) return out;
  let entries;
  try {
    entries = readdirSync(skillDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // no symlink follow (mirror listMarkdown R1 M1)
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...findSkillManifests(join(skillDir, e.name), rel, depth + 1));
    else if (e.name === "SKILL.md") out.push(rel);
  }
  return out;
}

function checkConsumerEfficacy(root, opts) {
  const id = "consumer-efficacy";
  const source_rule = "#408 AC#7 consumer-side efficacy gate (journal/0244)";
  const results = [];

  // Share the tree /sync just produced; else emit a fresh one ourselves.
  let emitDir = (opts && opts.emitDir) || null;
  let ownEmit = null;
  if (!emitDir) {
    ownEmit = emitFresh(root);
    if (!ownEmit.ok) {
      // Clean up the temp dir emitFresh allocated even on the failure path
      // (R1 cc-architect LOW-1; the sibling checkMirrorExclusion is fixed too).
      try {
        if (ownEmit.dir) rmSync(ownEmit.dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return {
        id,
        source_rule,
        results: [
          {
            artifact: "(emit)",
            status: STATUS.SKIP,
            detail: `could not run emit-cli-artifacts.mjs: ${(ownEmit.error || "").slice(0, 200)}`,
          },
        ],
      };
    }
    emitDir = ownEmit.dir;
  }

  const listFiles = (dir, pred) => {
    try {
      return readdirSync(dir).filter(pred);
    } catch {
      return null; // directory absent → caller SKIPs that lane
    }
  };
  // Non-empty STRING guard — parseFrontmatter maps a bare `key:` (empty value)
  // to [] (truthy), so `!fields.key` would pass an effectively-empty field
  // (R1 cc-architect MED-1). A quoted-empty `key: ""` → "" is already falsy.
  const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
  // Size-capped read (R1 security MED-2 — route every read through safeRead's
  // 10 MB cap + try/catch, matching the rest of the file; an unreadable/oversize
  // file or a mid-walk unlink TOCTOU becomes a FAIL row, never an uncaught throw
  // that crashes the /sync gate). Returns null after pushing the FAIL.
  const readOrFail = (file, tag, label) => {
    const t = safeRead(file);
    if (t === null) {
      results.push({ artifact: tag, status: STATUS.FAIL, detail: `${label}: unreadable or exceeds the 10 MB size cap` });
    }
    return t;
  };

  try {
    // ── A. Gemini commands — TOML parse-load.
    const gCmdDir = join(emitDir, "gemini", "commands");
    const gCmds = listFiles(gCmdDir, (n) => n.endsWith(".toml"));
    if (gCmds === null) {
      results.push({ artifact: "gemini/commands", status: STATUS.SKIP, detail: "no emitted commands lane" });
    } else {
      for (const n of gCmds) {
        const tag = `gemini/commands/${n}`;
        const text = readOrFail(join(gCmdDir, n), tag, "TOML");
        if (text === null) continue;
        const errs = validateGeminiCommandToml(text);
        if (errs.length) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: `TOML does not parse-load: ${errs.join("; ")}` });
        } else {
          results.push({ artifact: tag, status: STATUS.PASS });
        }
      }
    }

    // ── B. Codex prompts — frontmatter parse-load.
    const cPromptDir = join(emitDir, "codex", "prompts");
    const cPrompts = listFiles(cPromptDir, (n) => n.endsWith(".md"));
    if (cPrompts === null) {
      results.push({ artifact: "codex/prompts", status: STATUS.SKIP, detail: "no emitted prompts lane" });
    } else {
      for (const n of cPrompts) {
        const tag = `codex/prompts/${n}`;
        const text = readOrFail(join(cPromptDir, n), tag, "prompt");
        if (text === null) continue;
        const fm = parseFrontmatter(text);
        if (!fm.hasFrontmatter) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: "no frontmatter — Codex reads /prompts:<name> frontmatter natively" });
        } else if (fm.unterminated) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: "unterminated frontmatter (no closing ---) — will not parse-load" });
        } else if (!nonEmpty(fm.fields.name)) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: "frontmatter missing or empty `name`" });
        } else {
          results.push({ artifact: tag, status: STATUS.PASS });
        }
      }
    }

    // ── C. Skills (both lanes) — frontmatter parse-load. Skills may be leaf
    //   (<skill>/SKILL.md) or nested/multi-variant (<skill>/<variant>/SKILL.md),
    //   so the scan recurses. `name` is dir-derivable (CC loads name-less
    //   skills — 5 source skills ship without it), so parse-load requires only
    //   well-formed terminated frontmatter + a non-empty `description` — the
    //   load-bearing field that drives semantic activation on the no-path CLIs.
    for (const cli of ["codex", "gemini"]) {
      const skillsRoot = join(emitDir, cli, "skills");
      let dirs;
      try {
        // isDirectory() is already false for a symlink Dirent (no deref), but
        // the explicit skip matches the file's house pattern (R1 security LOW-3).
        dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter(
          (e) => e.isDirectory() && !e.isSymbolicLink(),
        );
      } catch {
        results.push({ artifact: `${cli}/skills`, status: STATUS.SKIP, detail: "no emitted skills lane" });
        continue;
      }
      for (const d of dirs) {
        const manifests = findSkillManifests(join(skillsRoot, d.name));
        if (manifests.length === 0) {
          results.push({
            artifact: `${cli}/skills/${d.name}`,
            status: STATUS.FAIL,
            detail: "skill dir emitted with no SKILL.md anywhere in its tree",
          });
          continue;
        }
        for (const rel of manifests) {
          const tag = `${cli}/skills/${d.name}/${rel}`;
          const text = readOrFail(join(skillsRoot, d.name, rel), tag, "SKILL.md");
          if (text === null) continue;
          const fm = parseFrontmatter(text);
          if (!fm.hasFrontmatter || fm.unterminated) {
            results.push({ artifact: tag, status: STATUS.FAIL, detail: "missing/unterminated frontmatter — will not parse-load" });
          } else if (!nonEmpty(fm.fields.description)) {
            results.push({ artifact: tag, status: STATUS.FAIL, detail: "frontmatter missing `description` (load-bearing for no-path-loader CLIs)" });
          } else {
            results.push({ artifact: tag, status: STATUS.PASS });
          }
        }
      }
    }

    // ── D. Rules-reference index integrity (AC#5-b delivery channel).
    const idxRel = "skills/rules-reference/SKILL.md";
    const codexIdx = join(emitDir, "codex", idxRel);
    const geminiIdx = join(emitDir, "gemini", idxRel);
    const cExists = existsSync(codexIdx);
    const gExists = existsSync(geminiIdx);
    if (!cExists && !gExists) {
      results.push({ artifact: "rules-reference", status: STATUS.SKIP, detail: "no rules-reference channel emitted (no skill-channel rules)" });
    } else if (cExists !== gExists) {
      // Lane-asymmetric delivery of the channel — a silent one-lane drop.
      const present = cExists ? "codex" : "gemini";
      const absent = cExists ? "gemini" : "codex";
      results.push({
        artifact: "rules-reference",
        status: STATUS.FAIL,
        detail: `rules-reference index emitted to ${present} but NOT ${absent} — lane-asymmetric delivery (silent drop on ${absent})`,
      });
    } else {
      for (const [cli, idxPath] of [["codex", codexIdx], ["gemini", geminiIdx]]) {
        const tag = `${cli}/rules-reference`;
        const text = readOrFail(idxPath, tag, "index SKILL.md");
        if (text === null) continue;
        const fm = parseFrontmatter(text);
        const citations = extractRulesIndexCitations(text);
        if (!fm.hasFrontmatter || fm.unterminated || !nonEmpty(fm.fields.name)) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: "index SKILL.md missing/unterminated frontmatter or `name` — will not parse-load" });
          continue;
        }
        if (citations.length === 0) {
          results.push({ artifact: tag, status: STATUS.FAIL, detail: "index emitted but cites zero rules — empty delivery channel" });
          continue;
        }
        const dangling = citations.filter((f) => !existsSync(join(root, ".claude", "rules", f)));
        if (dangling.length) {
          results.push({
            artifact: tag,
            status: STATUS.FAIL,
            detail: `index cites ${dangling.length} non-existent source rule(s) (consumer would fail to open): ${dangling.slice(0, 5).join(", ")}`,
          });
        } else {
          results.push({ artifact: tag, status: STATUS.PASS, detail: `${citations.length} cited rules all resolve` });
        }
      }
    }
  } finally {
    if (ownEmit && ownEmit.dir) {
      try {
        rmSync(ownEmit.dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  return { id, source_rule, results };
}

// =======================================================================
//  CHECK 6 — paths-glob ↔ Rules-Index annotation consistency
// =======================================================================
// In the emitted baseline surfaces (CLAUDE.md / AGENTS.md / GEMINI.md) a rule
// MAY be annotated with a path glob in its Rules-Index row. When it is, the
// rule's own `paths:` frontmatter MUST include that glob. Loom's own Rules
// Index carries no per-rule glob annotations, so this check is typically a
// vacuous PASS at loom and a live regression-lock for downstream USE templates
// whose CLAUDE.md does carry annotations (issue #350 Finding 3).
const RS_GLOB_RE = /\*\*\/\*\.(rs|py|rb|ts|js)\b/g;

function checkPathsAnnotationConsistency(root) {
  const id = "paths-annotation-consistency";
  const results = [];
  const indexFiles = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
    .map((f) => join(root, f))
    .filter(existsSync);
  if (indexFiles.length === 0) {
    return {
      id,
      source_rule: "cross-cli-parity (Rules-Index annotation)",
      results: [{ artifact: "CLAUDE.md", status: STATUS.SKIP, detail: "no baseline index file" }],
    };
  }
  let anyAnnotation = false;
  for (const idxFile of indexFiles) {
    const text = safeRead(idxFile);
    if (text === null) continue;
    const idxRel = relative(root, idxFile);
    for (const line of text.split(/\r?\n/)) {
      // A Rules-Index row may name MULTIPLE rule files with one shared glob
      // (e.g. "`rules/A.md` and `rules/B.md` | **/*.rs |"). Use matchAll so
      // every rule on the row is checked (reviewer R1 #1 — silent-drop on
      // 2nd+ rule per row was the original `.match` defect).
      const ruleRefs = [...line.matchAll(/`((?:\.claude\/)?rules\/[A-Za-z0-9_.-]+\.md)`/g)];
      const globs = [...line.matchAll(RS_GLOB_RE)].map((m) => m[0]);
      if (ruleRefs.length === 0 || globs.length === 0) continue;
      anyAnnotation = true;
      for (const ruleRef of ruleRefs) {
        const ruleRel = ruleRef[1].replace(/^\.claude\//, "");
        const rulePath = join(root, ".claude", ruleRel);
        const ruleText = safeRead(rulePath);
        if (ruleText === null) {
          results.push({ artifact: `${idxRel} → ${ruleRel}`, status: STATUS.FAIL, detail: "annotated rule file not found" });
          continue;
        }
        const { fields } = parseFrontmatter(ruleText);
        const paths = Array.isArray(fields.paths) ? fields.paths : [];
        const missing = globs.filter((g) => !paths.includes(g));
        if (missing.length === 0) {
          results.push({ artifact: `${idxRel} → ${ruleRel}`, status: STATUS.PASS });
        } else {
          results.push({
            artifact: `${idxRel} → ${ruleRel}`,
            status: STATUS.FAIL,
            detail: `Rules-Index annotates ${missing.join(", ")} but rule paths: lacks it (issue #350 Finding 3)`,
          });
        }
      }
    }
  }
  if (!anyAnnotation) {
    results.push({ artifact: "(rules-index)", status: STATUS.SKIP, detail: "no per-rule path-glob annotations in baseline index" });
  }
  return { id, source_rule: "cross-cli-parity (Rules-Index annotation)", results };
}

// =======================================================================
//  CHECK 7 — audit-fixture coverage
// =======================================================================
// Every `detect*` export in violation-patterns.js MUST have an audit-fixture
// dir with >=1 flag fixture AND >=1 clean fixture (cc-artifacts.md Rule 9 +
// hook-output-discipline.md MUST-4). Detector enumeration is a positive
// allowlist (the `detect*` name shape) per cc-artifacts.md Rule 10.
function enumerateDetectors(root) {
  const vp = safeRead(join(root, ".claude", "hooks", "lib", "violation-patterns.js"));
  if (vp === null) return null;
  // Parse the module.exports { ... } block; collect identifiers matching detect*.
  const exp = vp.match(/module\.exports\s*=\s*{([\s\S]*?)}/);
  const names = new Set();
  const scope = exp ? exp[1] : vp;
  for (const m of scope.matchAll(/\b(detect[A-Z][A-Za-z0-9]*)\b/g)) names.add(m[1]);
  return [...names];
}

function classifyFixtures(dir) {
  // Returns { flag, clean } counts based on filename convention.
  let flag = 0;
  let clean = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name.toLowerCase();
    if (n.includes("expected")) continue; // expected-output sidecars
    // reviewer R1 #2: strict prefix only. Previously a broader regex (`bad`,
    // `safe`, `dirty`, etc.) classified names like `clean-flag.txt` as flag,
    // silently turning "missing clean fixture" into a green PASS. The loom
    // convention is `^flag-` / `^clean-` per the #354 fixture set.
    if (/^flag[-_.]/.test(n)) flag++;
    else if (/^clean[-_.]/.test(n)) clean++;
  }
  return { flag, clean };
}

function checkAuditFixtureCoverage(root) {
  const id = "audit-fixture-coverage";
  const detectors = enumerateDetectors(root);
  if (detectors === null) {
    return {
      id,
      source_rule: "cc-artifacts.md Rule 9 / hook-output-discipline.md MUST-4",
      results: [{ artifact: "hooks/lib/violation-patterns.js", status: STATUS.SKIP, detail: "violation-patterns.js unreadable" }],
    };
  }
  const fixtureBase = join(root, ".claude", "audit-fixtures", "violation-patterns");
  const results = [];
  for (const det of detectors.sort()) {
    const dir = join(fixtureBase, det);
    const counts = classifyFixtures(dir);
    if (counts === null) {
      results.push({
        artifact: `violation-patterns/${det}`,
        status: STATUS.FIXTURE_NEEDED,
        detail: "no audit-fixture dir (issue #350 Finding 5)",
      });
    } else if (counts.flag >= 1 && counts.clean >= 1) {
      results.push({ artifact: `violation-patterns/${det}`, status: STATUS.PASS, detail: `${counts.flag} flag / ${counts.clean} clean` });
    } else {
      results.push({
        artifact: `violation-patterns/${det}`,
        status: STATUS.FIXTURE_NEEDED,
        detail: `needs >=1 flag + >=1 clean (have ${counts.flag} flag / ${counts.clean} clean)`,
      });
    }
  }
  return { id, source_rule: "cc-artifacts.md Rule 9 / hook-output-discipline.md MUST-4", results };
}

// Declared load-bearing carve-outs (ECO-IMPL W1 / D6). A positive allowlist
// (cc-artifacts.md Rule 10) of CONCRETE (wildcard-free) loom_only files that are
// permitted to sit UNDER a synced tier glob. Such a file is NOT a contradiction:
// sync-tier-aware.mjs::classifyFile suppresses it at step 2b (loom_only PRECEDES
// tier inclusion), so the one file is carved out of the synced tier while the
// rest of the tier still syncs — the INTENDED never-sync fence for a
// committed-but-ecosystem-private artifact (e.g. the D6 ecosystem registry,
// deliberately placed under bin/** so loom_only is LOAD-BEARING + this validator-
// checked). Adding an entry here is the EXPLICIT, auditable act of declaring such
// a fence; any within-tier loom_only file NOT on this list still FAILS loud
// (catching the inverse bug: a real synced artifact accidentally loom_only'd,
// which would silently starve every consumer). Paths are `.claude/`-relative,
// matching the loom_only stanza shape.
const LOOM_ONLY_TIER_CARVEOUTS = new Set(["bin/ecosystem.json"]);

// Check 8 — loom-only mutual exclusion (F104).
//   FAIL  a loom_only glob that ALSO appears as / swallows a tier entry (any
//         tier) — a path declared never-sync but also tier-listed would be both
//         emitted (by tier) and never-emitted (by loom_only); the manifest
//         contradicts itself. Blocks /sync. EXCEPTION: a concrete file in
//         LOOM_ONLY_TIER_CARVEOUTS is a declared load-bearing carve-out (PASS).
//   FIXTURE_NEEDED  (WARN, non-blocking would be ideal but the status taxonomy
//         only has pass/fail/fixture-needed/skip; per the F104 spec a
//         zero-match glob is a WARN, NOT a block) → emitted as `skip` with a
//         "WARN:" detail so it surfaces without blocking /sync.
//   PASS  a loom_only glob in no tier, OR a declared tier carve-out, that
//         matches >=1 on-disk file.
function checkLoomOnlyMutualExclusion(root) {
  const id = "loom-only-mutual-exclusion";
  const source_rule = "sync-manifest.yaml loom_only (F104) / cross-repo.md Rule 4";
  const loomOnly = parseLoomOnly(root);
  if (loomOnly === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  if (loomOnly.length === 0) {
    return {
      id,
      source_rule,
      results: [{ artifact: "loom_only", status: STATUS.SKIP, detail: "no loom_only entries declared" }],
    };
  }
  const tiers = parseTiers(root);
  // Flatten every tier's globs with the owning tier name (any tier is synced —
  // every tier is subscribed by >=1 repo per repos.<t>.tier_subscriptions).
  const tierEntries = [];
  for (const [tier, globs] of Object.entries(tiers)) {
    for (const g of globs) tierEntries.push({ tier, glob: g });
  }
  const results = [];
  for (const lo of loomOnly) {
    // (a) mutual-exclusion: loom_only glob collides with a synced-tier glob.
    const collisions = tierEntries.filter(
      (t) => t.glob === lo || loomGlobMatch(t.glob.replace(/^\.claude\//, ""), lo) || loomGlobMatch(lo, t.glob),
    );
    // A declared, concrete (wildcard-free) carve-out is the load-bearing fence,
    // not a contradiction (emit suppresses it at classifyFile step 2b). Any
    // OTHER within-tier loom_only entry still FAILS loud.
    const isCarveout = LOOM_ONLY_TIER_CARVEOUTS.has(lo) && !lo.includes("*");
    if (collisions.length > 0 && !isCarveout) {
      const where = collisions.map((c) => `${c.tier}:${c.glob}`).join(", ");
      results.push({
        artifact: lo,
        status: STATUS.FAIL,
        detail: `loom_only path is ALSO in synced tier(s) ${where} — a never-sync artifact cannot be tier-listed (mutual-exclusion violation). If this is an intended load-bearing carve-out, add it to LOOM_ONLY_TIER_CARVEOUTS.`,
      });
      continue;
    }
    // (b) zero-match WARN: glob matches no on-disk file. Non-blocking — emit
    // as SKIP with a WARN: prefix so it surfaces without halting /sync.
    const candidate = join(root, ".claude", lo);
    const exists = existsSync(candidate) || (lo.endsWith("/**") && existsSync(join(root, ".claude", lo.slice(0, -3))));
    if (!exists) {
      results.push({
        artifact: lo,
        status: STATUS.SKIP,
        detail: `WARN: loom_only glob matches 0 on-disk files (stale entry? verify the path)`,
      });
      continue;
    }
    results.push({
      artifact: lo,
      status: STATUS.PASS,
      detail: isCarveout
        ? `load-bearing carve-out (declared in LOOM_ONLY_TIER_CARVEOUTS): concrete loom_only file under synced tier(s) ${collisions.map((c) => `${c.tier}:${c.glob}`).join(", ")} — emit suppresses at classifyFile loom_only step (2b) before tier inclusion; the rest of the tier still syncs`
        : "never-sync, in no synced tier, matches on-disk file",
    });
  }
  return { id, source_rule, results };
}

// =======================================================================
//  CHECK — surface-role membership (D3 / onboarding-portability W2-b)
// =======================================================================
// DISTRIBUTE ≠ SURFACE. `tiers:` decides which repos RECEIVE an artifact;
// `surface_roles:` decides which ROLES present it in their surface. The two are
// ORTHOGONAL — an artifact MAY be BOTH tier-listed AND surface-role-scoped
// (invariant #1) — UNLIKE loom_only (check 8), which is mutually exclusive with
// tiers. This check therefore MUST NOT cross-check tier membership; a literal
// near-copy of checkLoomOnlyMutualExclusion would wrongly FAIL such an artifact.
// surface_roles is a POSITIVE declaration (never an exclude:-style denylist —
// emit ignores exclude: so a SURFACE restriction expressed as exclusion would
// silently leak; #638). DEFAULT-SURFACED: an artifact with no entry surfaces for
// every role (open decision #5); declare an entry ONLY to RESTRICT.
const VALID_SURFACE_ROLES = new Set(["platform", "build", "use-consumer"]);

// Parse the top-level `surface_roles:` block — keyed `<path>: [role, ...]`
// inline-flow-list entries at 2-space indent. Returns a KEYED Map path→roles[]
// (structurally DISTINCT from parseLoomOnly's flat string[] — invariant #4: the
// parsing IDIOM is reused, the return SHAPE is keyed). null when the manifest is
// unreadable; empty Map when the block is absent or has no entries.
function parseSurfaceRoles(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const out = new Map();
  let inBlock = false;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^surface_roles:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A new top-level key (col-0, ends with `:`) ends the block.
    if (/^[A-Za-z0-9_-]+:/.test(raw) && !raw.startsWith(" ")) break;
    // `  <path>: [role, role]`  (an inline `# comment` after the list is fine).
    const m = raw.match(/^ {2}([^:\s]+):\s*\[([^\]]*)\]/);
    if (m) {
      const roles = m[2]
        .split(",")
        .map((r) => r.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      out.set(m[1], roles);
    }
  }
  return out;
}

// Parse `repos.<target>.role` declarations (D3 / W2b-5 / redteam Finding 1). The
// repos: block is `2-space <target>:` headers with 4-space children; collect the
// `role:` child of each. Returns a Map target→role for every target that
// DECLARES one (absent target = full emission, invariant #7, NOT included). null
// when the manifest is unreadable.
function parseReposRoles(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const out = new Map();
  let inRepos = false;
  let cur = null;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^repos:\s*$/.test(raw)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    if (/^[A-Za-z0-9_-]+:/.test(raw) && !raw.startsWith(" ")) break;
    const target = raw.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (target) {
      cur = target[1];
      continue;
    }
    const roleM = raw.match(/^ {4}role:\s*(.+?)\s*$/);
    if (roleM && cur) {
      const v = roleM[1]
        .replace(/\s+#.*$/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      out.set(cur, v);
    }
  }
  return out;
}

// Check body. FAIL: out-of-enum role value (per-artifact OR per-target), or an
// EMPTY per-artifact role list (surfaces nowhere = unreachable). SKIP(WARN): a
// surface_roles path matching 0 on-disk files. PASS: valid + resolves. Tier
// membership is deliberately NOT consulted (orthogonality, invariant #1).
function checkSurfaceRoleMembership(root) {
  const id = "surface-role-membership";
  const source_rule =
    "sync-manifest.yaml surface_roles + repos.<t>.role (D3) / onboarding-portability W2-b";
  const sr = parseSurfaceRoles(root);
  const reposRoles = parseReposRoles(root);
  if (sr === null && reposRoles === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  const results = [];
  // (1) per-artifact surface_roles values
  if (sr) {
    for (const [p, roles] of sr) {
      const bad = roles.filter((r) => !VALID_SURFACE_ROLES.has(r));
      if (bad.length > 0) {
        results.push({
          artifact: p,
          status: STATUS.FAIL,
          detail: `surface_roles value(s) [${bad.join(", ")}] not in the closed role vocabulary {${[...VALID_SURFACE_ROLES].join(", ")}}`,
        });
        continue;
      }
      if (roles.length === 0) {
        results.push({
          artifact: p,
          status: STATUS.FAIL,
          detail: `surface_roles declares an EMPTY role list — an artifact that surfaces for NO role is unreachable; remove the entry to default-surface, or name >=1 role`,
        });
        continue;
      }
      const candidate = join(root, ".claude", p);
      const exists =
        existsSync(candidate) ||
        (p.endsWith("/**") && existsSync(join(root, ".claude", p.slice(0, -3))));
      if (!exists) {
        results.push({
          artifact: p,
          status: STATUS.SKIP,
          detail: `WARN: surface_roles path matches 0 on-disk files (stale entry? verify the path)`,
        });
        continue;
      }
      results.push({
        artifact: p,
        status: STATUS.PASS,
        detail: `surfaces for role(s) [${roles.join(", ")}] (orthogonal to tier/distribution)`,
      });
    }
  }
  // (2) per-target repos.<t>.role values (emit-lane subset selector, W2b-5)
  if (reposRoles) {
    for (const [target, role] of reposRoles) {
      if (!VALID_SURFACE_ROLES.has(role)) {
        results.push({
          artifact: `repos.${target}.role`,
          status: STATUS.FAIL,
          detail: `repos.${target}.role '${role}' not in the closed role vocabulary {${[...VALID_SURFACE_ROLES].join(", ")}}`,
        });
      } else {
        results.push({
          artifact: `repos.${target}.role`,
          status: STATUS.PASS,
          detail: `target role '${role}' valid (emit-lane subset selector)`,
        });
      }
    }
  }
  if (results.length === 0) {
    results.push({
      artifact: "surface_roles",
      status: STATUS.SKIP,
      detail: "no surface_roles or repos.<t>.role entries declared",
    });
  }
  return { id, source_rule, results };
}

// =======================================================================
//  CHECK 9 — provenance-event cross-CLI parity (F101-4 / loom#411 item 5)
// =======================================================================
// The CC lane captures provenance events (the F101-2 hooks) of the closed
// taxonomy EVENT_KINDS {HumanInput, Action, Decision, Delegation}. This check
// enforces that EVERY kind CC actually captures carries an EXPLICIT cross-CLI
// parity declaration for each target lane (codex, gemini) in the manifest's
// `provenance_parity` block — either `wired` (validator asserts the named hook
// is registered in that lane's emit target) or `deferred` (an explicit, tracked
// known gap, #NNN required). A captured kind with NO declaration for a lane is a
// SILENT DROP → FAIL (the failure mode #408 blocks). Source of truth for the
// captured-kind set is the HOOKS, not the declaration: the kinds are extracted
// from the capture-hook sources and byte-compared (canonicalSerialize, the
// csq-seam serializer) against the declared cc_capture set — drift is a hard
// finding. Structural per probe-driven-verification.md MUST-3 (no LLM).

// Target lanes = the non-cc CLIs of parity_enforcement.required_coverage.hooks.
// Stable set; mirrors cli-drift-audit.mjs CLIS minus the reference lane.
const PROVENANCE_TARGET_LANES = ["codex", "gemini"];
const PROVENANCE_KIND_SET = new Set(EVENT_KINDS);

// Parse the `provenance_parity:` block (a 2-space child of parity_enforcement)
// with a line-oriented state machine (the parseEmitExclusions idiom — no YAML
// dep). cc_capture / lanes list items are pipe-delimited single strings:
//   cc_capture:  "<kind>|<hook-file>|<cc-event>"
//   lanes (deferred): "<lane>|<kind>|deferred|<#tracking>|<reason…>"
//   lanes (wired):    "<lane>|<kind>|wired|<hook-file>|<lane-event>"
// Returns { present, enabled, ccCapture[], lanes[] } or null when absent.
function parseProvenanceParity(manifestText) {
  if (manifestText == null) return null;
  const lines = manifestText.split(/\r?\n/);
  let inBlock = false;
  let section = null; // "cc_capture" | "lanes"
  const out = { present: false, enabled: false, ccCapture: [], lanes: [] };
  for (const raw of lines) {
    if (/^  provenance_parity:\s*$/.test(raw)) {
      inBlock = true;
      out.present = true;
      continue;
    }
    if (!inBlock) continue;
    // Terminate on a 2-space-or-less alphabetic key (a sibling/parent key such
    // as `tiers:` at col 0). Comments (`#`), list items, and blanks do not end
    // the block.
    if (/^ {0,2}[A-Za-z_]/.test(raw)) {
      inBlock = false;
      continue;
    }
    const enabledM = raw.match(/^    enabled:\s*(true|false)\s*$/);
    if (enabledM) {
      out.enabled = enabledM[1] === "true";
      // Do NOT reset `section` here — `enabled:` is a scalar key and must not
      // drop the list items of a section it happens to follow if a future
      // hand-edit reorders fields (reviewer R1 LOW).
      continue;
    }
    if (/^    cc_capture:\s*$/.test(raw)) {
      section = "cc_capture";
      continue;
    }
    if (/^    lanes:\s*$/.test(raw)) {
      section = "lanes";
      continue;
    }
    // Any OTHER 4-space key header (e.g. `subagent_internal_capture:` — the
    // F128/#445 depth axis) terminates the current list section so its items
    // are NOT mis-collected into cc_capture/lanes. enabled/cc_capture/lanes are
    // handled above and `continue` before reaching here; this is the catch-all
    // that keeps a future sibling sub-key from polluting the {kind}×{cli} matrix.
    if (/^ {4}[A-Za-z_][\w-]*:\s*$/.test(raw)) {
      section = null;
      continue;
    }
    const item = raw.match(/^\s+-\s+"([^"]*)"\s*$/);
    if (item && section) {
      const parts = item[1].split("|");
      if (section === "cc_capture") {
        out.ccCapture.push({
          kind: parts[0] || "",
          hook: parts[1] || "",
          event: parts[2] || "",
          raw: item[1],
        });
      } else {
        out.lanes.push({
          lane: parts[0] || "",
          kind: parts[1] || "",
          status: parts[2] || "",
          // f4 = #tracking (deferred) | hook-file (wired)
          // f5 = reason (deferred)    | lane-event (wired); reason may contain `|`
          f4: parts[3] || "",
          f5: parts.slice(4).join("|"),
          raw: item[1],
        });
      }
    }
  }
  return out.present ? out : null;
}

// Parse the `subagent_internal_capture:` depth-axis sub-block (F128/#445), a
// 4-space child of `provenance_parity:`, sibling to cc_capture/lanes. Items are
// pipe-delimited "<lane>|<status>|<f4>|<reason…>"; status ∈
// {wired, residual-absent, residual-unverified}. Separate from
// parseProvenanceParity so the {kind}×{cli} matrix parser stays unpolluted (its
// catch-all section-reset keeps these items out of `lanes`). Returns
// { present, cells[] } or null when absent.
function parseSubagentInternalCapture(manifestText) {
  if (manifestText == null) return null;
  const lines = manifestText.split(/\r?\n/);
  let inParity = false;
  let inBlock = false;
  const out = { present: false, cells: [] };
  for (const raw of lines) {
    if (/^  provenance_parity:\s*$/.test(raw)) { inParity = true; continue; }
    if (!inParity) continue;
    // A 2-space-or-less alphabetic key ends provenance_parity entirely.
    if (/^ {0,2}[A-Za-z_]/.test(raw)) { inParity = false; inBlock = false; continue; }
    if (/^    subagent_internal_capture:\s*$/.test(raw)) { inBlock = true; out.present = true; continue; }
    // Any OTHER 4-space key header ends our sub-block.
    if (inBlock && /^ {4}[A-Za-z_][\w-]*:\s*$/.test(raw)) { inBlock = false; continue; }
    if (!inBlock) continue;
    const item = raw.match(/^\s+-\s+"([^"]*)"\s*$/);
    if (item) {
      const parts = item[1].split("|");
      out.cells.push({
        lane: parts[0] || "",
        status: parts[1] || "",
        f4: parts[2] || "",
        reason: parts.slice(3).join("|"),
        raw: item[1],
      });
    }
  }
  return out.present ? out : null;
}

// Frontmatter region (text between the first two `---` lines), or null. Used by
// the F128 wired-but-absent guard — a structural substring check (NOT a semantic
// regex per probe-driven-verification.md) for the provenance hook reference.
function frontmatterRegion(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return lines.slice(1, i).join("\n");
  }
  return null;
}

// Extract the kind: "<X>" string literals actually emitted by the declared CC
// capture hooks (the source of truth). `kind: classified.kind` (identifier, no
// quote) is intentionally not matched. Returns { kinds:Set, byHook:Map, errors }.
function extractHookKinds(root, ccCapture) {
  const errors = [];
  const kinds = new Set();
  const byHook = new Map();
  const hookFiles = [...new Set((ccCapture || []).map((c) => c.hook).filter(Boolean))];
  for (const hf of hookFiles) {
    const src = safeRead(join(root, ".claude", "hooks", hf));
    if (src === null) {
      errors.push(`cc_capture hook '${hf}' not found at .claude/hooks/${hf}`);
      continue;
    }
    // Strip JS comments BEFORE matching so a doc-comment `kind: "X"` neither
    // injects a phantom kind (over-match) NOR masks a real drift by supplying a
    // kind the code does not emit — a comment listing all 4 kinds in a hook whose
    // code returns 3 would otherwise hide the regression (security R1 MED). Accept
    // double / single / backtick quote forms so a non-double-quote emission is
    // still extracted; a MISSED emission would drop a kind silently, whereas an
    // extracted-but-different kind surfaces as a loud byte-drift FAIL (reviewer R1 MED).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const found = new Set();
    for (const m of code.matchAll(/\bkind:\s*["'`]([A-Za-z]+)["'`]/g)) found.add(m[1]);
    byHook.set(hf, found);
    for (const k of found) kinds.add(k);
  }
  return { kinds, byHook, errors };
}

// Pure evaluator — no IO. `laneHookPresent(lane, hookFile) => bool` is the
// emit-target presence oracle (injected so tests/fixtures drive it). Returns the
// validate-emit results[] array.
function evaluateProvenanceParity({
  block,
  extraction,
  laneHookPresent,
  hookEmitsKind,
  // #440: a `wired|<hook>@codex-mcp-guard` cell is verified via the guard's
  // exported capture contract, NOT the native lane emit target. Default false →
  // a guard-mechanism cell fails closed when no predicate is injected.
  guardCapturesHook = () => false,
}) {
  const MANIFEST = "sync-manifest.yaml::provenance_parity";
  if (!block) {
    return [
      {
        artifact: MANIFEST,
        status: STATUS.FAIL,
        detail:
          "provenance_parity block absent from sync-manifest.yaml (F101-4 / #411 item 5) — provenance capture has no declared cross-CLI parity contract",
      },
    ];
  }
  if (!block.enabled) {
    return [{ artifact: MANIFEST, status: STATUS.SKIP, detail: "provenance_parity.enabled=false" }];
  }
  const results = [];

  // (a) cc_capture must be non-empty when enabled.
  if (!block.ccCapture.length) {
    results.push({
      artifact: MANIFEST,
      status: STATUS.FAIL,
      detail: "provenance_parity.enabled=true but cc_capture is empty — no reference capture surface declared",
    });
  }

  // (b) declared cc_capture hook IO errors (missing/unreadable hook file).
  for (const e of extraction.errors) {
    results.push({ artifact: MANIFEST, status: STATUS.FAIL, detail: e });
  }

  // (c) every hook-emitted kind MUST be in the closed taxonomy EVENT_KINDS.
  for (const k of extraction.kinds) {
    if (!PROVENANCE_KIND_SET.has(k)) {
      results.push({
        artifact: `hook-kind:${k}`,
        status: STATUS.FAIL,
        detail: `capture hook emits kind "${k}" outside provenance-event.js::EVENT_KINDS [${EVENT_KINDS.join(", ")}]`,
      });
    }
  }

  // (d) each declared cc_capture entry must be backed by its hook + in-taxonomy.
  const declaredKinds = new Set();
  for (const c of block.ccCapture) {
    declaredKinds.add(c.kind);
    if (!PROVENANCE_KIND_SET.has(c.kind)) {
      results.push({
        artifact: `cc_capture:${c.kind}`,
        status: STATUS.FAIL,
        detail: `cc_capture declares kind "${c.kind}" outside EVENT_KINDS`,
      });
      continue;
    }
    const hookKinds = extraction.byHook.get(c.hook);
    if (hookKinds && !hookKinds.has(c.kind)) {
      results.push({
        artifact: `cc_capture:${c.kind}`,
        status: STATUS.FAIL,
        detail: `cc_capture maps ${c.kind} → ${c.hook} but that hook emits no kind: "${c.kind}" literal`,
      });
    }
  }

  // (e) byte-exact drift: declared cc_capture kind set vs hook-extracted set.
  // Arrays sorted before canonicalSerialize (it preserves array order; only
  // object keys are sorted). Compared as the csq-signable bytes (Buffer.equals).
  const declaredSorted = [...declaredKinds].sort();
  const extractedSorted = [...extraction.kinds].filter((k) => PROVENANCE_KIND_SET.has(k)).sort();
  const declBytes = canonicalSerialize(declaredSorted);
  const extrBytes = canonicalSerialize(extractedSorted);
  if (!declBytes.equals(extrBytes)) {
    results.push({
      artifact: MANIFEST,
      status: STATUS.FAIL,
      detail: `cc_capture kind set drifts from hook-emitted kinds (byte-exact seam): declared=${declBytes.toString(
        "utf8",
      )} hooks=${extrBytes.toString("utf8")}`,
    });
  }

  // The kinds parity is enforced over = hook-extracted (the source of truth);
  // fall back to declared if extraction yielded nothing (so a missing-hook
  // config still reports lane coverage rather than silently passing).
  const capturedKinds = extractedSorted.length ? extractedSorted : declaredSorted;

  // index + orphan-lane-decl check.
  const laneIndex = new Map();
  for (const cell of block.lanes) {
    laneIndex.set(`${cell.lane}|${cell.kind}`, cell);
    if (!PROVENANCE_TARGET_LANES.includes(cell.lane)) {
      results.push({
        artifact: `lanes:${cell.raw}`,
        status: STATUS.FAIL,
        detail: `lane "${cell.lane}" is not a target lane [${PROVENANCE_TARGET_LANES.join(", ")}]`,
      });
    } else if (!capturedKinds.includes(cell.kind)) {
      results.push({
        artifact: `lanes:${cell.raw}`,
        status: STATUS.FAIL,
        detail: `lanes declares parity for kind "${cell.kind}" which CC does not capture`,
      });
    }
  }

  // (f) per (target lane × captured kind): require an explicit declaration.
  for (const lane of PROVENANCE_TARGET_LANES) {
    for (const kind of capturedKinds) {
      const cell = laneIndex.get(`${lane}|${kind}`);
      const art = `${lane}:${kind}`;
      if (!cell) {
        results.push({
          artifact: art,
          status: STATUS.FAIL,
          detail: `SILENT DROP: CC captures provenance kind "${kind}" but ${lane} has no provenance_parity declaration (wired|deferred) — #408 no-silent-drops`,
        });
        continue;
      }
      if (cell.status === "deferred") {
        // f4 IS the tracking ref (one pipe-delimited field) — require the WHOLE
        // field to be `#NNN`, not merely contain it, so `see #1` / embedded-digit
        // noise is rejected (security R1 LOW).
        if (!/^#\d+$/.test(cell.f4 || "")) {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `deferred declaration MUST carry a #NNN tracking ref (got "${cell.f4}") — value-prioritization.md MUST-2`,
          });
        } else {
          results.push({
            artifact: art,
            status: STATUS.SKIP,
            detail: `deferred (tracked ${cell.f4}): ${cell.f5 || "(no reason given)"}`,
          });
        }
      } else if (cell.status === "wired") {
        // Field 4 is `<hook.js>` (native lane emit target) OR, per #440,
        // `<hook.js>@codex-mcp-guard` (the Codex MCP-guard mechanism for the one
        // wrapped tool — apply_patch — that has no native Codex hook, codex#16732).
        // Parsing the mechanism is load-bearing: provenance-capture-tool.js is
        // ALSO registered in .codex/hooks.json on the `shell` matcher, so a bare
        // `provenance-capture-tool.js` would false-pass codex|Decision via that
        // shell registration — yet shell never writes journal files, so Decision
        // never fires there. The `@codex-mcp-guard` qualifier forces verification
        // of the apply_patch guard path. This is a TIGHTENING, not a relaxation.
        const rawHook = cell.f4 || "";
        const atIdx = rawHook.indexOf("@");
        const hook = atIdx === -1 ? rawHook : rawHook.slice(0, atIdx);
        const mechanism = atIdx === -1 ? "native" : rawHook.slice(atIdx + 1);
        // The hook field MUST be a bare hook filename. Without this gate the
        // presence oracle's match could be satisfied by a generic token (".js" /
        // "node" / "hooks") present in every command string — a manifest-edit
        // false-pass that defeats the wired guarantee (security R1 HIGH). The
        // filename-shape constraint + segment-exact presence match (laneHookPresent)
        // are the two halves of that fix; an empty f4 fails the shape here too
        // (reviewer R1 LOW empty-f4 case).
        if (!/^[A-Za-z0-9_-]+\.js$/.test(hook)) {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `wired declaration field 4 must be a bare hook filename matching /^[A-Za-z0-9_-]+\\.js$/ (optionally suffixed @codex-mcp-guard); got "${rawHook}"`,
          });
        } else if (mechanism !== "native" && mechanism !== "codex-mcp-guard") {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `wired declaration field 4 has unknown capture mechanism "@${mechanism}" (expected a bare hook filename for the native lane emit target, or "<hook>@codex-mcp-guard" for the Codex MCP-guard mechanism)`,
          });
        } else if (mechanism === "codex-mcp-guard" && lane !== "codex") {
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `wired mechanism "@codex-mcp-guard" is only valid for the codex lane; got lane "${lane}"`,
          });
        } else if (
          mechanism === "native"
            ? !laneHookPresent(lane, hook)
            : !guardCapturesHook(hook)
        ) {
          // Presence: native → registered in the lane emit target; codex-mcp-guard
          // → captured by the guard on a wrapped tool (server.js CAPTURE_* SSOT).
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail:
              mechanism === "native"
                ? `declared wired → "${hook}" but that hook is NOT registered in the ${lane} emit target (.${lane}/...)`
                : `declared wired → "${hook}@codex-mcp-guard" but the codex-mcp-guard does NOT capture "${hook}" on a wrapped tool (server.js CAPTURE_HOOKS/CAPTURE_TOOLS — runtime capture not wired)`,
          });
        } else if (!hookEmitsKind(hook, kind)) {
          // Presence alone is insufficient: a wired cell could name ANY registered
          // hook (e.g. validate-bash-command.js, the Bash tripwire) that emits ZERO
          // provenance kinds — a visible-but-wrong PASS asserting capture-wiring that
          // does not exist (security R2 MED). A wired capture MUST name a
          // `.claude/hooks/*.js` that ACTUALLY emits the declared kind, regardless of
          // mechanism (native registration OR codex-mcp-guard invocation).
          results.push({
            artifact: art,
            status: STATUS.FAIL,
            detail: `declared wired → "${hook}" is reachable ${mechanism === "native" ? `via the ${lane} emit target` : "via the codex-mcp-guard"} but does NOT emit provenance kind "${kind}" (not a capture hook for this kind)`,
          });
        } else {
          results.push({
            artifact: art,
            status: STATUS.PASS,
            detail: `wired → ${hook} via ${mechanism === "native" ? `${lane} emit target` : "codex-mcp-guard"}${cell.f5 ? ` (${cell.f5})` : ""} AND emits ${kind}`,
          });
        }
      } else {
        results.push({
          artifact: art,
          status: STATUS.FAIL,
          detail: `unknown status "${cell.status}" for ${art} (expected wired|deferred)`,
        });
      }
    }
  }

  return results;
}

// Collect every `command` string value from a hook-registration JSON document
// (codex hooks.json / gemini settings.json). Returns [] on parse failure (a
// malformed emit target cannot satisfy a `wired` parity assertion).
function collectHookCommands(jsonText) {
  if (jsonText == null) return [];
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const cmds = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "command" && typeof v === "string") cmds.push(v);
        else walk(v);
      }
    }
  };
  walk(doc);
  return cmds;
}

// IO wrapper: load manifest + hooks + emit targets, build the presence oracle,
// delegate to the pure evaluator.
function checkProvenanceParity(root) {
  const id = "provenance-parity";
  const source_rule = "cross-cli-parity.md + loom#411 item 5 (F101-4)";
  const block = parseProvenanceParity(safeRead(join(root, ".claude", "sync-manifest.yaml")));
  const extraction = extractHookKinds(root, block ? block.ccCapture : []);
  const codexCmds = collectHookCommands(safeRead(join(root, ".codex", "hooks.json")));
  const geminiCmds = collectHookCommands(safeRead(join(root, ".gemini", "settings.json")));
  const laneHookPresent = (lane, hookFile) => {
    if (!hookFile) return false;
    const cmds = lane === "codex" ? codexCmds : lane === "gemini" ? geminiCmds : [];
    // Segment-exact match (NOT a raw substring): split each command on path
    // separators / whitespace / quotes and require an exact path-segment equal to
    // hookFile. A raw `.includes(hookFile)` lets a generic f4 token (".js"/"node")
    // false-pass (security R1 HIGH); the wired branch additionally constrains f4 to
    // a `*.js` filename shape, so this segment match is the second half of the fix.
    return cmds.some((c) => c.split(/[\s/"']+/).includes(hookFile));
  };
  // Does the named hook file actually EMIT the provenance kind? Reuses the same
  // hook-source extraction as the cc_capture source-of-truth (security R2 MED — a
  // wired hook must be a real capture hook for the kind, not just any registered
  // hook). A hook absent from .claude/hooks/ emits nothing → false → wired FAILs.
  const hookEmitsKind = (hookFile, kind) => {
    if (!/^[A-Za-z0-9_-]+\.js$/.test(hookFile)) return false;
    const ex = extractHookKinds(root, [{ hook: hookFile }]);
    const set = ex.byHook.get(hookFile);
    return !!(set && set.has(kind));
  };
  // #440: does the codex-mcp-guard genuinely capture <hookFile> on a wrapped
  // tool? Reads the guard's exported capture contract (server.js CAPTURE_HOOKS +
  // CAPTURE_TOOLS — the SSOT the guard's runtime capture step iterates). A
  // `wired|<hook>@codex-mcp-guard` codex cell is verified against the guard
  // mechanism (apply_patch capture) rather than the native .codex/hooks.json
  // registration, which cannot produce Decision (shell never writes journal
  // files). A missing / unreadable / unpopulated guard → false → wired FAILs.
  const guardCapturesHook = (hookFile) => {
    if (!/^[A-Za-z0-9_-]+\.js$/.test(hookFile)) return false;
    try {
      const guard = _require(
        join(root, ".claude", "codex-mcp-guard", "server.js"),
      );
      const hooks = Array.isArray(guard.CAPTURE_HOOKS)
        ? guard.CAPTURE_HOOKS
        : guard.CAPTURE_HOOK
          ? [guard.CAPTURE_HOOK]
          : [];
      const tools = Array.isArray(guard.CAPTURE_TOOLS) ? guard.CAPTURE_TOOLS : [];
      // The @codex-mcp-guard mechanism IS the apply_patch capture path (the one
      // wrapped tool with no native Codex hook, codex#16732). Verify apply_patch
      // membership SPECIFICALLY — not merely tools.length>0 — so a future guard
      // that captured only shell/unified_exec (the double-capture scenario the
      // design forbids) cannot satisfy a codex·Decision wired cell. Closes the gap
      // between "the guard captures something" and "the guard captures apply_patch"
      // (reviewer R1 LOW, journal/0219).
      return hooks.includes(hookFile) && tools.includes("apply_patch");
    } catch {
      return false;
    }
  };
  const results = evaluateProvenanceParity({
    block,
    extraction,
    laneHookPresent,
    hookEmitsKind,
    guardCapturesHook,
  });
  return { id, source_rule, results };
}

// Check 11 — subagent-internal provenance capture (F128 / loom#445).
//   The provenance-capture hook (F101-2) fires at top-level PreToolUse(*) but
//   NOT inside subagents (CC settings.json hooks do not propagate into subagent
//   tool calls — CC #27661 / #34692). #445 closes the CC blind spot by injecting
//   an agent-frontmatter PreToolUse(*) hook into every .claude/agents/**/*.md.
//   This check is the WIRED-BUT-ABSENT guard: when the manifest declares
//   cc=wired, EVERY non-_README source agent MUST carry the hook in its
//   frontmatter — a missing one means subagent-internal capture silently does
//   not fire for that agent. Codex/Gemini are documented residuals (no per-agent
//   hook primitive — verify-resource-existence MUST-2/3); the check asserts they
//   are DECLARED (no-silent-drop) but makes no agent-file assertion. Runs against
//   the loom checkout (the agent source of truth); SKIPs when .claude/agents is
//   absent (a consumer repo's emitted tree has no source agents to assert).
function checkProvenanceSubagentHooks(root) {
  const id = "provenance-subagent-hooks";
  const source_rule = "loom#445 (F128) subagent-internal provenance capture (journal/0220)";
  const HOOK_REF = "provenance-capture-tool.js";
  const MANIFEST = "sync-manifest.yaml::provenance_parity.subagent_internal_capture";
  const block = parseSubagentInternalCapture(safeRead(join(root, ".claude", "sync-manifest.yaml")));
  if (!block) {
    return {
      id,
      source_rule,
      results: [{
        artifact: MANIFEST,
        status: STATUS.FAIL,
        detail: "subagent_internal_capture block absent — the F128/#445 depth axis is undeclared (no-silent-drop: declare cc + codex + gemini dispositions)",
      }],
    };
  }
  const results = [];
  const cellOf = (lane) => block.cells.find((c) => c.lane === lane);

  // --- CC lane: wired-but-absent guard ---
  const cc = cellOf("cc");
  const agentsDir = join(root, ".claude", "agents");
  if (!cc) {
    results.push({ artifact: MANIFEST, status: STATUS.FAIL, detail: "no `cc` cell — the CC lane disposition is undeclared" });
  } else if (cc.status === "wired") {
    if (!existsSync(agentsDir)) {
      results.push({ artifact: MANIFEST, status: STATUS.SKIP, detail: "cc=wired but .claude/agents absent — runs against the loom checkout only" });
    } else {
      const agents = listMarkdown(agentsDir).filter((f) => basename(f) !== "_README.md");
      const missing = agents.filter((f) => {
        const fm = frontmatterRegion(safeRead(f));
        return !fm || !fm.includes(HOOK_REF);
      });
      if (missing.length) {
        for (const m of missing) {
          results.push({
            artifact: relative(root, m),
            status: STATUS.FAIL,
            detail: `cc=wired but agent frontmatter lacks the ${HOOK_REF} PreToolUse hook — subagent-internal capture would silently NOT fire for this agent (#445 wired-but-absent)`,
          });
        }
      } else {
        results.push({
          artifact: MANIFEST,
          status: STATUS.PASS,
          detail: `cc=wired verified: ${agents.length}/${agents.length} source agents carry the ${HOOK_REF} agent-frontmatter PreToolUse hook`,
        });
      }
    }
  } else {
    results.push({
      artifact: MANIFEST,
      status: STATUS.FAIL,
      detail: `cc cell status="${cc.status}" — CC supports agent-frontmatter hooks (journal/0220); the only correct CC disposition is wired`,
    });
  }

  // --- Codex / Gemini residual lanes: declared (no-silent-drop), not fabricated ---
  for (const lane of ["codex", "gemini"]) {
    const cell = cellOf(lane);
    if (!cell) {
      results.push({ artifact: `${MANIFEST} [${lane}]`, status: STATUS.FAIL, detail: `no \`${lane}\` cell — the ${lane} disposition is undeclared (no-silent-drop)` });
    } else if (cell.status === "residual-absent" || cell.status === "residual-unverified") {
      results.push({ artifact: `${MANIFEST} [${lane}]`, status: STATUS.PASS, detail: `${lane}=${cell.status} (documented residual per verify-resource-existence MUST-2/3)` });
    } else if (cell.status === "wired") {
      results.push({ artifact: `${MANIFEST} [${lane}]`, status: STATUS.FAIL, detail: `${lane}=wired but no per-agent hook primitive exists on ${lane} — a wired claim would be fabricated (verify-resource-existence MUST-3)` });
    } else {
      results.push({ artifact: `${MANIFEST} [${lane}]`, status: STATUS.FAIL, detail: `${lane} status="${cell.status}" unrecognized (expected wired | residual-absent | residual-unverified)` });
    }
  }
  return { id, source_rule, results };
}

// Check 10 — `.coc/` artifact-id soundness (#392).
//   FAIL  the .coc/ emitter throws: a source artifact name derives to an
//         invalid id (spec §9.2.1, e.g. >33 chars) OR two names collide on one
//         id within a kind (spec §9.4.2 — csq hard-errors coc.duplicate_id).
//   SKIP+WARN  an emitted file exceeds the 60 KiB producer budget. spec-09
//         imposes NO consumer-side size cap, so this is a producer-quality
//         WARN, NOT a /sync block (emitting a truncated body would lose
//         load-bearing content per zero-tolerance.md Rule 2/6).
//   PASS  the .coc/ tree emits cleanly.
//   SKIP  validate-emit pointed at a non-loom root (emitCoc reads the loom
//         checkout; the check is meaningful only there).
function checkCocArtifactIds(root) {
  const id = "coc-artifact-ids";
  const source_rule = "issue #392 / spec-09 §9.2.1 + §9.4.2 (governance.csq)";
  if (resolve(root) !== EMIT_REPO) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".coc/", status: STATUS.SKIP, detail: "runs against the loom checkout only" }],
    };
  }
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "validate-coc-"));
    // Full-corpus emit (no --target) gates the FILENAME-DERIVED invariants for
    // EVERY per-target coc-sync Step 6.7 emit: deriveId is a pure function of the
    // source filename + kind, so id-grammar (§9.2.1) and within-kind id-collision
    // (§9.4.2) are target-invariant — a clean full-corpus emit implies them for
    // every tier-filtered subset (--target only REMOVES whole artifacts). NOT
    // target-invariant: a language variant overlay (--target <lang>) can REPLACE
    // an artifact's frontmatter, so a typed-field throw introduced by an overlay's
    // frontmatter is exercised only when that target emits (at its /sync-to-use).
    const r = emitCoc({ outDir: tmp });
    const results = [
      {
        artifact: ".coc/",
        status: STATUS.PASS,
        detail: `${r.records} artifacts (rules=${r.counts.rules} agents=${r.counts.agents} skills=${r.counts.skills} commands=${r.counts.commands})`,
      },
    ];
    for (const w of r.warnOversize) {
      results.push({
        artifact: w.relInCoc,
        status: STATUS.SKIP,
        detail: `WARN: ${w.bytes}B > 60KiB producer budget — emitted, not truncated (spec-09 has no consumer cap)`,
      });
    }
    return { id, source_rule, results };
  } catch (err) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".coc/", status: STATUS.FAIL, detail: String((err && err.message) || err) }],
    };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Orchestration ------------------------------------------------------

// ── Check: hook-delivery (#408 AC#6 / journal/0241) ──────────────────────
// Mirrors the per-RULE cli_delivery contract (Validator 18) for HOOKS. Every
// .claude/hooks/*.js MUST resolve to exactly ONE declared delivery lane in the
// sync-manifest `hook_delivery` block. A hook on disk with NO declaration is a
// SILENT DROP (the #408 failure mode) → FAIL; a declaration with no hook on
// disk is an orphan → FAIL; a duplicate declaration or invalid lane → FAIL.
// Runs against the loom checkout (the hook source of truth); SKIPs when
// .claude/hooks is absent (a consumer's emitted tree carries no source hooks).
// SCOPE: the GLOBAL hook tree only. Variant-overlay hooks (variants/<lang>/hooks/)
// are language-axis overlays delivered per-language; their cross-CLI lane is a
// separate axis not covered here (documented in sync-manifest hook_delivery).
const HOOK_DELIVERY_LANES = Object.freeze(["mcp-guard", "provenance", "cc-only"]);

// Parse the `hook_delivery:` block (a 2-space child of parity_enforcement) with
// the parseProvenanceParity line-oriented idiom (no YAML dep). Items are
// pipe-delimited single strings: "<hook>.js|<lane>|<reason>". Returns
// { present, enabled, map: Map<hook,{lane,reason}>, duplicates: [] } or null.
function parseHookDelivery(manifestText) {
  if (manifestText == null) return null;
  const lines = manifestText.split(/\r?\n/);
  let inBlock = false;
  let section = null; // "declarations"
  const out = { present: false, enabled: false, map: new Map(), duplicates: [] };
  for (const raw of lines) {
    if (/^  hook_delivery:\s*$/.test(raw)) {
      inBlock = true;
      out.present = true;
      continue;
    }
    if (!inBlock) continue;
    // Terminate on a 0-2-space alphabetic key (a sibling/parent such as
    // `tiers:` at col 0). Comments, list items, blanks do not end the block.
    if (/^ {0,2}[A-Za-z_]/.test(raw)) {
      inBlock = false;
      continue;
    }
    const enM = raw.match(/^    enabled:\s*(true|false)\s*$/);
    if (enM) {
      out.enabled = enM[1] === "true";
      continue;
    }
    if (/^    declarations:\s*$/.test(raw)) {
      section = "declarations";
      continue;
    }
    // Any OTHER 4-space key header terminates the declarations section so its
    // items are not mis-collected (a future sibling sub-key under hook_delivery).
    if (/^ {4}[A-Za-z_][\w-]*:\s*$/.test(raw)) {
      section = null;
      continue;
    }
    const item = raw.match(/^\s+-\s+"([^"]*)"\s*$/);
    if (item && section === "declarations") {
      const parts = item[1].split("|");
      const hook = (parts[0] || "").trim();
      const lane = (parts[1] || "").trim();
      if (!hook) continue;
      if (out.map.has(hook)) {
        if (!out.duplicates.includes(hook)) out.duplicates.push(hook);
      } else {
        out.map.set(hook, { lane, reason: parts.slice(2).join("|") });
      }
    }
  }
  return out;
}

function checkHookDelivery(root) {
  const id = "hook-delivery";
  const source_rule = "cross-cli-parity.md hooks-coverage + #408 AC#6 (journal/0241)";
  const hooksDir = join(root, ".claude", "hooks");
  let diskHooks;
  try {
    // withFileTypes + isFile() for symbol parity with listMarkdown's symlink
    // discipline (a planted symlink is excluded rather than name-listed).
    diskHooks = readdirSync(hooksDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".js"))
      .map((e) => e.name)
      .sort();
  } catch {
    return {
      id,
      source_rule,
      results: [
        {
          artifact: ".claude/hooks",
          status: STATUS.SKIP,
          detail: "hooks dir absent (consumer emitted tree — no source hooks)",
        },
      ],
    };
  }
  const block = parseHookDelivery(
    safeRead(join(root, ".claude", "sync-manifest.yaml")),
  );
  const results = [];
  if (!block || !block.present) {
    results.push({
      artifact: "sync-manifest.yaml::hook_delivery",
      status: STATUS.FAIL,
      detail:
        "hook_delivery block ABSENT — every hook is an undeclared silent drop (#408 AC#6)",
    });
    return { id, source_rule, results };
  }
  // enabled:false → SKIP (idiom parity with evaluateProvenanceParity; the gate is
  // fail-closed, so a disabled-but-still-enforcing surprise is avoided).
  if (block.enabled === false) {
    return {
      id,
      source_rule,
      results: [
        {
          artifact: "sync-manifest.yaml::hook_delivery",
          status: STATUS.SKIP,
          detail: "hook_delivery.enabled:false — check disabled",
        },
      ],
    };
  }
  const declMap = block.map;
  const diskSet = new Set(diskHooks);
  // 1. Every hook on disk MUST be declared exactly once with a valid lane.
  for (const h of diskHooks) {
    const d = declMap.get(h);
    if (!d) {
      results.push({
        artifact: `hooks/${h}`,
        status: STATUS.FAIL,
        detail:
          "UNDECLARED in hook_delivery — SILENT DROP (no Codex/Gemini delivery lane declared). Declare mcp-guard|provenance|cc-only.",
      });
      continue;
    }
    if (!HOOK_DELIVERY_LANES.includes(d.lane)) {
      results.push({
        artifact: `hooks/${h}`,
        status: STATUS.FAIL,
        detail: `invalid lane "${d.lane}" (allowed: ${HOOK_DELIVERY_LANES.join("|")})`,
      });
      continue;
    }
    results.push({
      artifact: `hooks/${h}`,
      status: STATUS.PASS,
      detail: `lane=${d.lane}`,
    });
  }
  // 2. Every declaration MUST exist on disk (orphan guard).
  for (const [h] of declMap) {
    if (!diskSet.has(h)) {
      results.push({
        artifact: `hook_delivery::${h}`,
        status: STATUS.FAIL,
        detail:
          "declared hook NOT on disk (orphan declaration) — remove the declaration or restore the hook",
      });
    }
  }
  // 3. Duplicate declarations.
  for (const h of block.duplicates) {
    results.push({
      artifact: `hook_delivery::${h}`,
      status: STATUS.FAIL,
      detail: "declared more than once — exactly one lane required",
    });
  }
  // 4. Lane-correctness cross-validation against the AUTHORITATIVE fresh
  // extraction (extract-policies res.policies) — reuse the canonical extractor,
  // NEVER a divergent re-parse (the #408 AC#5-a/b lesson). A declared mcp-guard
  // hook MUST be in the mirrored set; a declared cc-only hook MUST NOT be. This
  // is the structural defense against a lane label silently lying — the committed
  // policies.json is stale (DF-AC6-2), so it is NOT the baseline; the live
  // extraction is. provenance is exempt (its delivery is governed by the
  // provenance-parity check). When the extractor is unavailable (a CC-only
  // consumer with no codex-mcp-guard), the cross-check is skipped — the
  // membership checks above still hold.
  const mirrored = deriveMirroredHookSet(root);
  if (mirrored) {
    for (const [h, d] of declMap) {
      if (!diskSet.has(h) || d.lane === "provenance") continue;
      const isMirrored = mirrored.has(h);
      if (d.lane === "mcp-guard" && !isMirrored) {
        results.push({
          artifact: `hooks/${h}`,
          status: STATUS.FAIL,
          detail:
            "declared mcp-guard but ABSENT from the fresh codex-mcp-guard extraction (res.policies) — the label does not match actual Codex delivery",
        });
      } else if (d.lane === "cc-only" && isMirrored) {
        results.push({
          artifact: `hooks/${h}`,
          status: STATUS.FAIL,
          detail:
            "declared cc-only but PRESENT in the fresh codex-mcp-guard extraction (res.policies) — should be mcp-guard",
        });
      }
    }
  }
  return { id, source_rule, results };
}

// Derive the AUTHORITATIVE mcp-guard set (the fresh extract-policies res.policies
// table that becomes policies.json on emit) by running the CANONICAL extractor
// as a subprocess — reuse, not a divergent re-implementation of the matcher +
// shape-classification logic. Returns a Set of source_file basenames, or null
// when the extractor is absent/unparseable (a CC-only consumer) so the caller
// skips the cross-check rather than hard-failing.
function deriveMirroredHookSet(root) {
  const extractor = join(
    root,
    ".claude",
    "codex-mcp-guard",
    "extract-policies.mjs",
  );
  if (!existsSync(extractor)) return null;
  const hooksDir = join(root, ".claude", "hooks");
  try {
    const out = execFileSync(process.execPath, [extractor, hooksDir, "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const res = JSON.parse(out);
    const set = new Set();
    for (const tool of Object.keys(res.policies || {})) {
      for (const e of res.policies[tool] || []) {
        if (e && e.source_file) set.add(e.source_file);
      }
    }
    return set;
  } catch {
    return null;
  }
}

// =======================================================================
//  CHECK 14 — codex-mcp-guard policies.json freshness (DF-AC6-2)
// =======================================================================
// The committed `.claude/codex-mcp-guard/policies.json` is what server.js
// loads at runtime to decide which CC hooks gate each Codex tool. README §66
// claims it is "regenerated on every /sync" — but nothing enforced that, so it
// froze at its original commit while settings.json gained Bash registrations
// (operator-gate / signing-mutation-guard / genesis-anchor-guard), silently
// dropping those gates from Codex. This check asserts the committed artifact
// deep-equals a FRESH extraction (the canonical extractor, same invocation
// deriveMirroredHookSet uses) — drift FAILs /sync with the regen command.

// Canonical stringify of a policies table: tool keys sorted, each tool's
// entries sorted by source_file, entry keys sorted. Deterministic so the
// committed-vs-fresh compare is order-insensitive.
function canonicalPolicies(policies) {
  const tools = Object.keys(policies || {}).sort();
  const out = {};
  for (const t of tools) {
    out[t] = [...(policies[t] || [])]
      .map((e) => ({
        source_file: e.source_file,
        cc_matchers: [...(e.cc_matchers || [])].sort(),
        invocation: e.invocation,
      }))
      .sort((a, b) => (a.source_file < b.source_file ? -1 : a.source_file > b.source_file ? 1 : 0));
  }
  return JSON.stringify(out);
}

function checkCodexPoliciesFresh(root) {
  const id = "codex-policies-fresh";
  const source_rule = "codex-mcp-guard policies.json freshness (DF-AC6-2 / journal/0246)";
  const committedPath = join(root, ".claude", "codex-mcp-guard", "policies.json");
  const extractor = join(root, ".claude", "codex-mcp-guard", "extract-policies.mjs");
  const tag = "codex-mcp-guard/policies.json";
  // CC-only consumer (no codex-mcp-guard dir) → nothing to keep fresh.
  if (!existsSync(extractor) || !existsSync(committedPath)) {
    return {
      id,
      source_rule,
      results: [{ artifact: tag, status: STATUS.SKIP, detail: "no codex-mcp-guard (CC-only consumer)" }],
    };
  }
  let committed;
  const committedText = safeRead(committedPath); // 10 MB cap + try/catch (R1 security I1)
  if (committedText === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: tag, status: STATUS.FAIL, detail: "committed policies.json unreadable or exceeds the 10 MB size cap" }],
    };
  }
  try {
    committed = JSON.parse(committedText).policies || {};
  } catch (e) {
    return {
      id,
      source_rule,
      results: [{ artifact: tag, status: STATUS.FAIL, detail: `committed policies.json unparseable: ${String(e.message).slice(0, 120)}` }],
    };
  }
  const hooksDir = join(root, ".claude", "hooks");
  const settingsPath = join(root, ".claude", "settings.json");
  let fresh;
  try {
    // realpathSync resolves a symlinked checkout prefix (/tmp, /var, symlinked
    // home) so the extractor's `import.meta.url === file://${argv[1]}` entrypoint
    // guard matches — otherwise main() silently no-ops, stdout is empty, and the
    // freshness gate would SKIP on a stale file (R1 reviewer MED-1). timeout
    // bounds a hung extractor so it cannot wedge /sync (R1 security L2).
    const extractorReal = realpathSync(extractor);
    const out = execFileSync(
      process.execPath,
      [extractorReal, hooksDir, "--json", "--settings", settingsPath],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "ignore"] },
    );
    fresh = JSON.parse(out).policies || {};
  } catch (e) {
    // The extractor is PRESENT (existsSync checked above) but did not produce
    // parseable output — a freshness gate MUST NOT silently pass/skip on a broken
    // extractor (R1 reviewer LOW-1: validator-13 tests extractPolicies() as a
    // direct import, NOT this live subprocess path, so it cannot see this
    // failure). FAIL loud — SKIP is reserved for the extractor being ABSENT
    // (CC-only consumer) per the existsSync gate above.
    return {
      id,
      source_rule,
      results: [{ artifact: tag, status: STATUS.FAIL, detail: `extract-policies.mjs present but produced no parseable output (${String(e.message).slice(0, 100)}) — cannot verify freshness` }],
    };
  }
  if (canonicalPolicies(committed) === canonicalPolicies(fresh)) {
    const n = Object.values(fresh).reduce((a, p) => a + p.length, 0);
    return { id, source_rule, results: [{ artifact: tag, status: STATUS.PASS, detail: `matches fresh extraction (${n} policy entries)` }] };
  }
  // Drift — summarize per-tool add/drop so the fix is obvious.
  const setOf = (p, t) => new Set((p[t] || []).map((e) => e.source_file));
  const allTools = [...new Set([...Object.keys(committed), ...Object.keys(fresh)])].sort();
  const diffs = [];
  for (const t of allTools) {
    const c = setOf(committed, t);
    const f = setOf(fresh, t);
    const added = [...f].filter((x) => !c.has(x));
    const dropped = [...c].filter((x) => !f.has(x));
    if (added.length || dropped.length) {
      diffs.push(`${t}: +[${added.join(",")}] -[${dropped.join(",")}]`);
    }
  }
  return {
    id,
    source_rule,
    results: [{
      artifact: tag,
      status: STATUS.FAIL,
      detail:
        `STALE — committed policies.json diverges from a fresh extraction (${diffs.join("; ")}). ` +
        `Regenerate: node .claude/codex-mcp-guard/extract-policies.mjs .claude/hooks ` +
        `--write-policies .claude/codex-mcp-guard/policies.json --settings .claude/settings.json`,
    }],
  };
}

// =======================================================================
//  CHECK 15 — variant-orphan (todo 16 / sync-upflow Wave 2b)
// =======================================================================
// Every TRACKED file under .claude/variants/ MUST be accounted for by exactly
// the positive allowlist below (cc-artifacts.md Rule 10 — closed allowlist, not
// a denylist). The check exists because the sync-manifest is HUMAN-maintained at
// Gate 1; a manual drop (a file moved, globalized, or re-classified without its
// stale leftover deleted) leaves an undeclared orphan that no other check sees.
//
// THE LOAD-BEARING DO-NOT (the client-report symptom): the allowlist MUST union
// BOTH the `variants:` REPLACEMENT lane AND the `variant_only:<lang>` ADDITION
// lane. A checker reading `variants:` ALONE reports ~200 false orphans (505
// tracked − 303 `variants:` paths), because `variant_only:` (177 paths, zero
// overlap) is an EQUAL declaration source it ignored — the exact 202-false-
// positive a client hit live. Unioning both sections is the systemic fix every
// coc-tier consumer of this validator gets for free.
//
// The 5 allowlist arms a tracked variants/ file MUST match (else → orphan FAIL):
//   1. variants-overlay   — a non-null overlay VALUE in `variants:` (any lang).
//   2. variant-only       — listed in `variant_only:<lang>` (any lang).
//   3. convention-rule/wrapper — a RULE under a convention-composed axis tree
//      (variants/<axis>/rules/, axis ∈ langs ∪ clis ∪ lang-cli ternaries —
//      consumed by emit.mjs::composeRule filesystem convention) OR a CLI wrapper
//      (variants/<cli>/wrappers/ per variant-authoring Rule 4).
//   4. null-ack           — the file sits at the conventional phantom path of a
//      `variants:` <artifact-key> whose value for THIS lang is explicitly `null`
//      (the documented phantom-overlay suppression, emit.mjs null-axis skip).
//   5. readme-or-example  — a README / `.example.` companion doc.
//
// Enumeration is `git ls-files` (NOT the filesystem): untracked operator-local
// `*.local.md` companions are by-design local and OUT of scope.

// Convention-tree axes (arm 3). Langs + CLIs are the canonical sets the emitter
// iterates (emit.mjs declaredTargets + the codex/gemini cli list); the ternary
// lang-cli axes are their cross product. A file under variants/<axis>/rules/ is
// composed by filesystem convention iff <axis> is in this set.
//
// SSOT NOTE: these two arrays MUST stay in sync with the emitter's axis sets —
// VARIANT_LANGS mirrors `emit.mjs` `declaredTargets` (the lang list `composeRule`
// iterates) and VARIANT_CLIS mirrors the codex/gemini cli list in `emit.mjs`
// main(). If a future lane adds an axis to the emitter but NOT here, a
// legitimately-composed variants/<newaxis>/rules/... file is mis-flagged as an
// orphan (a false /sync BLOCK — fail-CLOSED, never a false allow). When you touch
// either array, re-grep `declaredTargets` + the `clis = ... ["codex","gemini"]`
// line in emit.mjs and mirror the change.
const VARIANT_LANGS = ["py", "rs", "rb", "base", "prism"];
const VARIANT_CLIS = ["codex", "gemini"];
function variantConventionAxes() {
  const axes = new Set([...VARIANT_LANGS, ...VARIANT_CLIS]);
  for (const l of VARIANT_LANGS) for (const c of VARIANT_CLIS) axes.add(`${l}-${c}`);
  return axes;
}
const VARIANT_AXES = variantConventionAxes();

// Parse the `variants:` REPLACEMENT block. Returns
//   { overlays: Set<string>, nullCells: Array<{key,lang}> }
// where `overlays` are the non-null overlay path VALUES (.claude-relative, e.g.
// "variants/rs/rules/patterns.md") and `nullCells` records each <key>×<lang>
// cell explicitly set to `null` (the phantom-suppression arm-4 source). Returns
// null when the manifest is unreadable. Line-oriented (the parseTiers idiom).
function parseVariantsBlock(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const overlays = new Set();
  const nullCells = [];
  let inBlock = false;
  let curKey = null;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^variants:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A non-space, non-comment char at column 0 ends the block (next top-level key).
    if (/^[^\s#]/.test(raw)) break;
    if (/^\s*(#.*)?$/.test(raw)) continue; // blank or comment line
    // 2-space artifact-key header: `  rules/patterns.md:` (empty value after colon).
    const keyM = raw.match(/^ {2}([^\s#][^:]*):\s*(#.*)?$/);
    if (keyM) {
      curKey = keyM[1].trim();
      continue;
    }
    // 4-space lang line: `    py: null` | `    rs: variants/rs/rules/patterns.md`.
    const langM = raw.match(/^ {4}([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (langM && curKey) {
      const lang = langM[1];
      let val = langM[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (val === "" || val === "null" || val === "~") {
        nullCells.push({ key: curKey, lang });
      } else {
        overlays.add(val);
      }
    }
  }
  return { overlays, nullCells };
}

// Parse the `variant_only:` ADDITION block into a flat Set of every declared
// path (.claude-relative), across all langs. Returns null when unreadable.
function parseVariantOnlyAll(root) {
  const manifest = safeRead(join(root, ".claude", "sync-manifest.yaml"));
  if (manifest === null) return null;
  const out = new Set();
  let inBlock = false;
  for (const raw of manifest.split(/\r?\n/)) {
    if (/^variant_only:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^[^\s#]/.test(raw)) break; // next top-level key ends the block
    if (/^\s*(#.*)?$/.test(raw)) continue; // blank or comment
    const item = raw.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      const v = item[1].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (v) out.add(v);
    }
    // lang headers (`  py:`) need no capture — we collect the flat path set.
  }
  return out;
}

// Pure classifier — the testable core (no IO). `relPath` is .claude-relative
// (e.g. "variants/py/skills/project/foo.md"). Returns { ok, arm }.
function classifyVariantFile(relPath, { overlays, variantOnly, nullPhantoms }) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  // arm 5 — README / .example. companion docs (cheapest, unambiguous; first).
  if (base === "README.md" || base === "_README.md" || relPath.includes(".example.")) {
    return { ok: true, arm: "readme-or-example" };
  }
  // arm 1 — a declared overlay VALUE in `variants:`.
  if (overlays.has(relPath)) return { ok: true, arm: "variants-overlay" };
  // arm 2 — a `variant_only:<lang>` entry.
  if (variantOnly.has(relPath)) return { ok: true, arm: "variant-only" };
  // arm 4 — a null-ACK phantom (variants: <key> with this lang explicitly null).
  if (nullPhantoms.has(relPath)) return { ok: true, arm: "null-ack" };
  // arm 3 — convention axis tree: variants/<axis>/rules/<…> OR variants/<cli>/wrappers/<…>.
  const m = relPath.match(/^variants\/([^/]+)\/(rules|wrappers)\/.+/);
  if (m) {
    const axis = m[1];
    const sub = m[2];
    if (sub === "rules" && VARIANT_AXES.has(axis)) return { ok: true, arm: "convention-rule" };
    if (sub === "wrappers" && VARIANT_CLIS.includes(axis)) return { ok: true, arm: "convention-wrapper" };
  }
  return { ok: false, arm: "orphan" };
}

// Enumerate TRACKED files under .claude/variants/ via git (NOT the filesystem —
// untracked operator-local companions are out of scope by design). Returns an
// array of repo-relative paths, or null when git is unavailable.
function listTrackedVariants(root) {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--", ".claude/variants"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function checkVariantOrphan(root) {
  const id = "variant-orphan";
  const source_rule =
    "sync-manifest.yaml variants/variant_only (todo 16 / sync-upflow Wave 2b) / cc-artifacts.md Rule 10";
  if (!existsSync(join(root, ".claude", "variants"))) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".claude/variants", status: STATUS.SKIP, detail: "no variants/ dir (consumer tree — variants/ is loom-only)" }],
    };
  }
  const tracked = listTrackedVariants(root);
  if (tracked === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: ".claude/variants", status: STATUS.SKIP, detail: "git ls-files unavailable (not a git checkout)" }],
    };
  }
  const variantsBlock = parseVariantsBlock(root);
  const variantOnly = parseVariantOnlyAll(root);
  if (variantsBlock === null || variantOnly === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "sync-manifest.yaml", status: STATUS.SKIP, detail: "manifest unreadable" }],
    };
  }
  // arm-4 phantom paths: the conventional overlay path of each null cell.
  const nullPhantoms = new Set(
    variantsBlock.nullCells.map((c) => `variants/${c.lang}/${c.key}`),
  );
  const ctx = { overlays: variantsBlock.overlays, variantOnly, nullPhantoms };
  const results = [];
  for (const f of tracked) {
    const rel = f.startsWith(".claude/") ? f.slice(".claude/".length) : f;
    if (!rel.startsWith("variants/")) continue;
    const c = classifyVariantFile(rel, ctx);
    if (c.ok) {
      results.push({ artifact: rel, status: STATUS.PASS, detail: c.arm });
    } else {
      results.push({
        artifact: rel,
        status: STATUS.FAIL,
        detail:
          "undeclared variant orphan — matches NO allowlist arm (variants: overlay / variant_only: / convention axis tree / null-ack / README-.example). Declare an overlay or variant_only:<lang> entry, OR delete the leftover (todo 16).",
      });
    }
  }
  if (results.length === 0) {
    results.push({ artifact: ".claude/variants", status: STATUS.SKIP, detail: "no tracked variant files" });
  }
  return { id, source_rule, results };
}

// =======================================================================
//  CHECK 16 — self-referential-codify allowlist ⊆ paths: glob coverage (#443)
// =======================================================================
// self-referential-codify.md carries TWO co-dependent path surfaces:
//   1. the named-file ALLOWLIST (Rule 2) — the FIRING scope: the gate (Rule 1)
//      fires the multi-agent redteam on a /codify touching any of these files.
//   2. the `paths:` frontmatter globs — the LOAD-TRIGGER scope: which edits
//      LOAD the rule into context.
// The rule states this invariant in prose (Rule 2 § "paths: frontmatter is the
// load-trigger SUPERSET; this allowlist is the firing-scope SUBSET"): EVERY
// allowlist file MUST be covered by ≥1 paths: glob, else editing that file does
// NOT load the rule and the gate that should fire on it silently does not —
// the #440 `.claude/codex-mcp-guard/**` gap class. This check makes that prose
// invariant structural: parse BOTH surfaces, assert every concrete allowlist
// entry resolves to ≥1 covering glob. An uncovered entry is a BLOCKING finding.
//
// Structural per probe-driven-verification.md MUST-3 (set-membership over two
// parsed path surfaces — no LLM, no regex-over-prose-semantics). Runs against
// the loom checkout (the rule is loom-authored); SKIPs when the rule is absent
// (a consumer's emitted tree carries the rule as a SYNCED artifact but a glob
// gap there is loom's to fix, surfaced here at /sync time before distribution).

// The rule's `Rule 2` allowlist is partitioned into EXACTLY these category
// bullets (`- **<Category>:** ...`). The discriminator is the bullet label's
// FIRST WORD — a fixed, declared set mirroring the Rule-2 enumeration. This
// EXCLUDES the Trust-Posture-Wiring bullets (Severity / Grace period /
// Regression-within-grace / Receipt requirement / Detection ...) and the
// Distinct-From bullets (Extends / Pairs / Distinct), which share the
// `- **<Label>:**` shape but are NOT allowlist sources.
const ALLOWLIST_CATEGORY_FIRST_WORDS = new Set([
  "Commands", "Skills", "Rules", "Hooks", "Data", "Bin",
  "Tools", "Codex", "Audit", "Management",
]);

// Path-prefix gate: a genuine allowlist entry is a real artifact path. Prose
// backtick references inside a bullet (rule names like `cc-artifacts.md`, §
// citations) are bare — they do NOT carry one of these repo-root prefixes.
const ALLOWLIST_PATH_PREFIX = /^(\.claude\/|tools\/|scripts\/)/;

// Brace-expand `{a,b,c}` (recursively, supporting one brace group at a time as
// the rule authors them — e.g. `.claude/rules/{trust-posture,cc-artifacts}.md`
// → two entries). Globs containing `*` (e.g. `validate-*.mjs`) are returned
// as-is for coverage matching; the `*` is irrelevant to /**-prefix coverage.
function braceExpandAllowlist(s) {
  const m = s.match(/^(.*?)\{([^}]*)\}(.*)$/);
  if (!m) return [s];
  const [, pre, inner, post] = m;
  const out = [];
  for (const part of inner.split(",")) out.push(...braceExpandAllowlist(pre + part + post));
  return out;
}

// Strip balanced parentheticals (depth-aware) — the per-entry "(added … per …)"
// prose explanations carry backtick references that are NOT allowlist entries
// (`.claude/**`, `cc-artifacts.md`, the trailing-slash subtree fragments). The
// genuine allowlist paths sit OUTSIDE the parentheticals, comma/`+`-separated.
function stripParentheticals(s) {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { if (depth > 0) depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

// Parse the named-file allowlist from self-referential-codify.md's Rule-2
// category bullets. Returns a sorted string[] of concrete `.claude/`-rooted (or
// tools/ / scripts/) paths + glob entries, or null when the rule is unreadable.
function parseSelfRefAllowlist(ruleText) {
  if (ruleText == null) return null;
  const entries = new Set();
  // Single-line-bullet assumption: each Rule-2 category bullet keeps its
  // backtick allowlist paths on ONE physical line. A future hard-wrapped
  // category bullet would drop its continuation-line entries (line-oriented
  // parse). The current corpus keeps all category bullets single-line; the
  // validator file is itself self-ref-allowlisted (Bin lane), so an edit
  // that wraps a bullet fires the multi-agent gate (#443 R1 redteam LOW).
  for (const ln of ruleText.split(/\r?\n/)) {
    const lm = ln.match(/^- \*\*([^:*]+)/);
    if (!lm) continue;
    const first = lm[1].trim().split(/\s+/)[0];
    if (!ALLOWLIST_CATEGORY_FIRST_WORDS.has(first)) continue;
    const body = stripParentheticals(ln);
    for (const m of body.matchAll(/`([^`]+)`/g)) {
      for (const e of braceExpandAllowlist(m[1].trim())) {
        // Trailing-slash fragments (`.claude/hooks/lib/`) are prose subtree
        // references, never a file entry — a real entry names a file or a /**
        // glob. Reject a bare-dir token (ends in `/`, no `**`).
        if (e.endsWith("/")) continue;
        if (ALLOWLIST_PATH_PREFIX.test(e)) entries.add(e);
      }
    }
  }
  return [...entries].sort();
}

// Parse the `paths:` frontmatter glob list from a rule file. Returns string[]
// (may be empty) or null when the file is unreadable / has no frontmatter.
function parsePathsFrontmatter(ruleText) {
  if (ruleText == null) return null;
  const { hasFrontmatter, fields } = parseFrontmatter(ruleText);
  if (!hasFrontmatter) return null;
  return Array.isArray(fields.paths) ? fields.paths : [];
}

// Does `glob` cover allowlist `entry`? Coverage forms the rule's frontmatter
// uses: an exact path (`.claude/sync-manifest.yaml`) OR a `/**` directory
// prefix (`.claude/commands/**`). An allowlist entry may ITSELF be a glob
// (`.claude/bin/validate-*.mjs`, `.claude/skills/sweep/**`); a `/**` parent
// glob covers any child path/glob under its prefix. A `*` in the entry's
// basename is irrelevant to a /**-prefix match (the prefix is the directory).
//
// Brace-set globs: the rule's own SUPERSET prose writes the load-trigger
// frontmatter as `.claude/{commands,rules,skills,hooks,bin}/**`; a future
// author MAY collapse the `paths:` frontmatter to that same brace-set form.
// `glob` is therefore brace-expanded (the SAME `braceExpandAllowlist` the
// allowlist side uses) before matching — a brace-set glob covers `entry` iff
// ANY of its expansions covers it. WITHOUT this, a brace-set `paths:` entry
// would match NO allowlist entry on the literal `===`/prefix test and silently
// UNDER-cover the firing-scope allowlist, dropping the Rule-1 multi-agent gate
// on a sibling self-referential surface (the security-relevant trust-substrate
// weakening #443 R1 security-reviewer flagged). The expansion is symmetric with
// the allowlist parse, so the two surfaces can never drift on brace handling.
function allowlistGlobCovers(glob, entry) {
  for (const g of braceExpandAllowlist(glob)) {
    if (g === entry) return true;
    if (g.endsWith("/**")) {
      const prefix = g.slice(0, -3);
      // entry === prefix (the dir itself) OR entry is under prefix/.
      if (entry === prefix || entry.startsWith(prefix + "/")) return true;
    }
  }
  return false;
}

function checkAllowlistPathsCoverage(root) {
  const id = "allowlist-paths-coverage";
  const source_rule =
    "self-referential-codify.md Rule 2 § paths-superset/allowlist-subset (#443 / #440 gap class)";
  const rulePath = join(root, ".claude", "rules", "self-referential-codify.md");
  const ruleText = safeRead(rulePath);
  if (ruleText === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "rules/self-referential-codify.md", status: STATUS.SKIP, detail: "rule unreadable or absent" }],
    };
  }
  const allowlist = parseSelfRefAllowlist(ruleText);
  const globs = parsePathsFrontmatter(ruleText);
  if (allowlist === null || globs === null) {
    return {
      id,
      source_rule,
      results: [{ artifact: "rules/self-referential-codify.md", status: STATUS.SKIP, detail: "could not parse allowlist or paths: frontmatter" }],
    };
  }
  const results = [];
  if (allowlist.length === 0) {
    return {
      id,
      source_rule,
      results: [{ artifact: "rules/self-referential-codify.md", status: STATUS.SKIP, detail: "no allowlist entries parsed (category-bullet shape changed?)" }],
    };
  }
  for (const entry of allowlist) {
    const covering = globs.filter((g) => allowlistGlobCovers(g, entry));
    if (covering.length >= 1) {
      results.push({ artifact: entry, status: STATUS.PASS, detail: `covered by paths: ${covering[0]}` });
    } else {
      results.push({
        artifact: entry,
        status: STATUS.FAIL,
        detail: `allowlist entry covered by NO paths: glob — editing it does NOT load self-referential-codify.md, so the Rule-1 gate silently does not fire (the #440 codex-mcp-guard gap class). Add a covering glob (exact path or <dir>/**) to the rule's paths: frontmatter.`,
      });
    }
  }
  return { id, source_rule, results };
}

const CHECK_FNS = {
  "command-frontmatter": checkCommandFrontmatter,
  "command-line-cap": checkCommandLineCap,
  "readonly-specialist-tools": checkReadonlySpecialistTools,
  "tool-canonicality": checkToolCanonicality,
  "mirror-exclusion": checkMirrorExclusion,
  "paths-annotation-consistency": checkPathsAnnotationConsistency,
  "audit-fixture-coverage": checkAuditFixtureCoverage,
  "loom-only-mutual-exclusion": checkLoomOnlyMutualExclusion,
  "provenance-parity": checkProvenanceParity,
  "provenance-subagent-hooks": checkProvenanceSubagentHooks,
  "hook-delivery": checkHookDelivery,
  "coc-artifact-ids": checkCocArtifactIds,
  "consumer-efficacy": checkConsumerEfficacy,
  "codex-policies-fresh": checkCodexPoliciesFresh,
  "variant-orphan": checkVariantOrphan,
  "allowlist-paths-coverage": checkAllowlistPathsCoverage,
  "surface-role-membership": checkSurfaceRoleMembership,
};

function runChecks(root, only, opts) {
  const ids = only && only.length ? only : CHECK_IDS;
  const checks = [];
  for (const id of ids) {
    const fn = CHECK_FNS[id];
    if (!fn) {
      process.stderr.write(`validate-emit: unknown check '${id}'\n`);
      process.exit(2);
    }
    checks.push(fn(root, opts));
  }
  return checks;
}

function applyAllowlist(checks, allow) {
  // allow: Set of "<check-id>:<artifact>" strings.
  for (const c of checks) {
    for (const r of c.results) {
      if (isBlocking(r.status) && allow.has(`${c.id}:${r.artifact}`)) {
        r.allowed = true;
      }
    }
  }
}

function parseArgs(argv) {
  const out = { json: false, help: false, only: [], allow: new Set(), emitDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--check") out.only.push(argv[++i]);
    else if (a.startsWith("--check=")) out.only.push(a.slice("--check=".length));
    else if (a === "--allow") out.allow.add(argv[++i]);
    else if (a.startsWith("--allow=")) out.allow.add(a.slice("--allow=".length));
    else if (a === "--emit-dir") out.emitDir = argv[++i];
    else if (a.startsWith("--emit-dir=")) out.emitDir = a.slice("--emit-dir=".length);
    else {
      process.stderr.write(`validate-emit: unknown flag '${a}'\n`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  return `validate-emit.mjs — pre-emit validator (issue #350 Stage 2)

usage:
  node .claude/bin/validate-emit.mjs [--json] [--check <id>] [--allow <id>:<path>] [--help]

flags:
  --json              emit JSON report to stdout (machine-readable)
  --check ID          run only check ID (repeatable). One of:
                      ${CHECK_IDS.join(", ")}
  --allow ID:PATH     suppress a specific (check, artifact) blocking finding
                      (repeatable; echoed in the report for audit)
  --emit-dir DIR      compare check 5 (mirror-exclusion) against an already-
                      emitted tree at DIR (DIR/codex, DIR/gemini). /sync passes
                      the tree it just produced; standalone runs emit a fresh
                      temp tree automatically.
  --help, -h          show this message and exit 0

exit codes:
  0  no blocking findings (all pass/skip, or every fail/fixture-needed allowed)
  1  >=1 unallowed blocking finding
  2  usage / IO error
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const root = findRepoRoot(process.cwd());
  const checks = runChecks(root, args.only, { emitDir: args.emitDir });
  applyAllowlist(checks, args.allow);

  // Tally.
  let blocking = 0;
  let allowed = 0;
  const tally = { pass: 0, fail: 0, "fixture-needed": 0, skip: 0 };
  for (const c of checks) {
    for (const r of c.results) {
      tally[r.status] = (tally[r.status] || 0) + 1;
      if (isBlocking(r.status)) {
        if (r.allowed) allowed++;
        else blocking++;
      }
    }
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: blocking === 0,
          tally,
          blocking,
          allowed,
          allowlist: [...args.allow],
          checks: checks.map((c) => ({
            id: c.id,
            source_rule: c.source_rule,
            results: c.results,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write("validate-emit — pre-emit rule-corpus sweep (issue #350)\n\n");
    for (const c of checks) {
      const fails = c.results.filter((r) => isBlocking(r.status) && !r.allowed);
      const allowedHere = c.results.filter((r) => isBlocking(r.status) && r.allowed);
      const mark = fails.length ? "FAIL" : "ok";
      process.stdout.write(`[${mark}] ${c.id}  (${c.source_rule})\n`);
      for (const r of fails) {
        process.stdout.write(`      ✗ ${r.artifact} — ${r.detail || r.status}\n`);
      }
      for (const r of allowedHere) {
        process.stdout.write(`      ~ ${r.artifact} — ALLOWED (${r.detail || r.status})\n`);
      }
    }
    process.stdout.write(
      `\nsummary: ${tally.pass} pass / ${tally.fail} fail / ${tally["fixture-needed"]} fixture-needed / ${tally.skip} skip` +
        ` — ${blocking} blocking${allowed ? `, ${allowed} allowed` : ""}\n`,
    );
    if (blocking > 0) {
      process.stdout.write(
        `\n/sync is BLOCKED. Fix the findings above, or pass --allow=<check-id>:<artifact> to suppress a specific finding (recorded in the /sync commit message).\n`,
      );
    }
  }
  process.exit(blocking > 0 ? 1 : 0);
}

// Export internals for the audit-fixture harness.
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  parseFrontmatter,
  parseToolList,
  matchesGlob,
  emitFresh,
  presentInEmit,
  parseEmitExclusions,
  parseReadonlySpecialists,
  enumerateDetectors,
  classifyFixtures,
  checkCommandFrontmatter,
  checkCommandLineCap,
  checkReadonlySpecialistTools,
  checkToolCanonicality,
  checkMirrorExclusion,
  checkPathsAnnotationConsistency,
  checkAuditFixtureCoverage,
  checkLoomOnlyMutualExclusion,
  checkProvenanceParity,
  parseProvenanceParity,
  checkProvenanceSubagentHooks,
  parseSubagentInternalCapture,
  checkHookDelivery,
  parseHookDelivery,
  checkConsumerEfficacy,
  validateGeminiCommandToml,
  extractRulesIndexCitations,
  checkCodexPoliciesFresh,
  canonicalPolicies,
  checkVariantOrphan,
  parseVariantsBlock,
  parseVariantOnlyAll,
  classifyVariantFile,
  listTrackedVariants,
  checkAllowlistPathsCoverage,
  checkSurfaceRoleMembership,
  parseSurfaceRoles,
  parseReposRoles,
  VALID_SURFACE_ROLES,
  parseSelfRefAllowlist,
  parsePathsFrontmatter,
  allowlistGlobCovers,
  braceExpandAllowlist,
  stripParentheticals,
  VARIANT_AXES,
  VARIANT_LANGS,
  VARIANT_CLIS,
  deriveMirroredHookSet,
  frontmatterRegion,
  extractHookKinds,
  evaluateProvenanceParity,
  collectHookCommands,
  parseLoomOnly,
  parseTiers,
  loomGlobMatch,
  PROVENANCE_TARGET_LANES,
  CANONICAL_CC_TOOLS,
  READONLY_FORBIDDEN_TOOLS,
  CHECK_IDS,
  STATUS,
  findRepoRoot,
};

if (isMain) main();
