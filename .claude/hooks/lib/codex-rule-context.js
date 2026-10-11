"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { resolveRuleMetadata, parseManifestCliExclusions } = require("./rule-metadata");
const MAX_BYTES = 4 * 1024 * 1024;

function within(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function readOrdinary(root, relative) {
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error("rule source escapes project root");
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("rule source contains a symlink");
  }
  const canonical = canonicalPath(target);
  if (!within(root, canonical)) throw new Error("rule source resolves outside project root");
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("rule source is not a bounded ordinary file");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > MAX_BYTES) throw new Error("rule source exceeds read limit");
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function targetPath(root, cwd, file) {
  if (typeof file !== "string" || !file || file.includes("\0")) throw new Error("typed file operation requires a valid path");
  const base = canonicalPath(cwd || root);
  if (!checkoutTop(root, base)) throw new Error("rule activation cwd is outside the installed repository");
  const lexical = path.resolve(base, file);
  const suffix = [];
  let cursor = lexical;
  while (!fs.existsSync(cursor)) {
    // lstat distinguishes an absent component from a dangling symlink.
    try { fs.lstatSync(cursor); throw new Error("file target is a dangling symlink"); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("file target has no resolvable parent");
    suffix.unshift(path.basename(cursor)); cursor = parent;
  }
  const canonical = path.join(canonicalPath(cursor), ...suffix); // existing prefix: on-disk name; new suffix: typed
  if (!checkoutTop(root, canonical)) throw new Error("rule activation target is outside the installed repository");
  // Match aliases and canonical names (see matchForms) so neither an in-tree alias nor
  // a checkout nested in the root can hide a rule. No path-race safety claimed.
  return [...new Set([lexical, canonical].flatMap(p => matchForms(root, p)))];
}

function ruleExclusions(root, sources) {
  const optional = relative => {
    try { return readOrdinary(root, relative).toString("utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const manifest = optional(".claude/sync-manifest.yaml");
  const projection = optional(".claude/.coc-cli-emit.yaml");
  const version = optional(".claude/VERSION");
  if (manifest === null && projection === null && version === null) return new Map();
  const type = version === null ? null : JSON.parse(version)?.type?.trim();
  let text;
  if (type === "coc-source") {
    if (manifest === null) throw new Error("source rule authority requires sync-manifest.yaml");
    text = manifest;
  } else if (["coc-build", "coc-use-template", "coc-project"].includes(type)) {
    if (manifest !== null) throw new Error("consumer rule authority cannot use a source sync manifest");
    text = projection;
  } else throw new Error("rule exclusion authority requires a known VERSION class");
  if (text === null) return new Map();
  const required = type === "coc-source" ? ["tiers"] : ["cli_variants", "cli_emit_exclusions", "multi_cli_overlays"];
  if (!text.trim() || required.some(key => !new RegExp(`^${key}:\\s*$`, "m").test(text))) throw new Error("rule exclusion authority is truncated or lacks required stanza");
  const exclusions = parseManifestCliExclusions(text);
  for (const patterns of Object.values(exclusions)) {
    if (patterns.length > 1024 || patterns.some(p => p.length > 1024 || /[\0\n\r]/.test(p))) throw new Error("rule exclusion patterns exceed bounds");
  }
  const names = [...sources.keys()];
  const script = `const fs=require('node:fs');const {globToRegex}=require(process.argv[1]);const {exclusions,names}=JSON.parse(fs.readFileSync(0,'utf8'));const compiled=Object.fromEntries(['codex','gemini'].map(cli=>[cli,exclusions[cli].map(globToRegex)]));process.stdout.write(JSON.stringify(names.map(name=>Object.fromEntries(['codex','gemini'].map(cli=>[cli,compiled[cli].some(re=>re.test(name.slice(8)))])))));`;
  const result = spawnSync(process.execPath, ["-e", script, require.resolve("./artifact-glob")], {
    input: JSON.stringify({ exclusions, names }), encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("rule exclusion matching could not finish inside its bounded budget");
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== names.length || rows.some(row => typeof row?.codex !== "boolean" || typeof row?.gemini !== "boolean")) throw new Error("invalid rule exclusion matcher result");
  return new Map(names.map((name, i) => [name, rows[i]]));
}

function collectRuleContext(rootInput, payload, projections) {
  const root = canonicalPath(rootInput);
  const typed = projections.filter(p => ["Read", "Write", "Edit", "NotebookEdit"].includes(p.tool_name));
  if (!typed.length) return "";
  const targets = [...new Set(typed.flatMap(p => targetPath(root, payload.cwd, p.tool_input?.file_path || p.tool_input?.notebook_path)))];
  const indexPath = ".codex/rules-index.json";
  if (!fs.existsSync(path.join(root, indexPath))) return "[Codex rule activation unavailable] The emitted rule catalog is missing. Read .claude/rules for these typed targets before proceeding; regenerate the Codex artifacts to enable automatic activation.";
  const catalog = JSON.parse(readOrdinary(root, indexPath).toString("utf8"));
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.rules) || catalog.rules.length > 1024) throw new Error("invalid Codex rule catalog");
  const selected = [], candidates = [], seen = new Set();
  let totalBytes = 0;
  const sources = new Map();
  function inventory(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const source = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("canonical rule inventory contains a symlink");
      // Canonical enumeration is top-level; deployment-local baseline rules
      // are separately composed (.claude/rules/local/_README.md:25–39).
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (sources.size >= 1024) throw new Error("canonical rule inventory exceeds limit");
      const bytes = readOrdinary(root, source);
      totalBytes += bytes.length;
      if (totalBytes > 8 * MAX_BYTES) throw new Error("rule catalog exceeds aggregate source byte limit");
      const fm = bytes.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
      sources.set(source, { bytes, fm });
    }
  }
  inventory(".claude/rules");
  const exclusions = ruleExclusions(root, sources);
  for (const [source, row] of sources) Object.assign(row, resolveRuleMetadata(row.fm, exclusions.get(source)));
  for (const row of catalog.rules) {
    if (!row || typeof row.source !== "string" || !/^\.claude\/rules\/[A-Za-z0-9_./-]+\.md$/.test(row.source) || row.source.split("/").includes("..") || seen.has(row.source) ||
        !/^[a-f0-9]{64}$/.test(row.sha256) || !Array.isArray(row.paths) || row.paths.length > 512 || typeof row.applicable !== "boolean") throw new Error("invalid Codex rule catalog row");
    seen.add(row.source);
    const authority = sources.get(row.source);
    if (!authority || JSON.stringify(authority.paths) !== JSON.stringify(row.paths) || authority.applicable !== row.applicable) throw new Error(`Codex rule catalog metadata differs from canonical source: ${row.source}`);
    const { bytes } = authority;
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error(`stale Codex rule catalog: ${row.source}; regenerate before continuing`);
    row.paths.forEach(glob => {
      if (typeof glob !== "string" || glob.length > 1024 || /[\0\n\r]/.test(glob)) throw new Error("invalid rule path pattern");
    });
    if (!row.applicable || !row.paths.length) continue;
    const body = bytes.toString("utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    candidates.push({ paths: row.paths, text: `### ${row.source}\n${body.trim()}` });
  }
  for (const [source, row] of sources) if (row.applicable && !seen.has(source)) throw new Error(`Codex rule catalog omits canonical rule: ${source}`);
  if (!candidates.length) return "";
  const script = `const fs=require('node:fs'); const {globToRegex}=require(process.argv[1]); const {paths,targets}=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(paths.map(globs=>globs.some(g=>{const re=globToRegex(g); return targets.some(t=>re.test(t));}))));`;
  const result = spawnSync(process.execPath, ["-e", script, require.resolve("./artifact-glob")], {
    input: JSON.stringify({ paths: candidates.map(row => row.paths), targets }), encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("rule matching could not finish inside its bounded budget");
  const decisions = JSON.parse(result.stdout);
  if (!Array.isArray(decisions) || decisions.length !== candidates.length || !decisions.every(v => typeof v === "boolean")) throw new Error("invalid rule matcher result");
  decisions.forEach((matched, index) => { if (matched) selected.push(candidates[index].text); });
  return selected.length ? `Applicable canonical rules for ${targets.join(", ")}:\n\n${selected.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Checkout membership — the ONE containment predicate for typed Codex targets
// ---------------------------------------------------------------------------
// The installed repository is a FAMILY of checkouts sharing one git common dir:
// the main worktree plus every linked worktree (`git worktree add`), which
// usually lives OUTSIDE the main tree (e.g. a sibling `.loom-wt/<name>`). A
// lexical `within(root, …)` test alone refuses every linked worktree, so a Codex
// worker assigned a sibling lane could not make a typed edit in it.
//
// Membership is decided by filesystem reads only (no git subprocess in a hook),
// fail-CLOSED: any missing file, parse failure, oversized pointer, symlinked
// `.git`, non-canonical top, or mismatch answers "not a member". A linked
// checkout is a member iff ALL of:
//   (0) DECLARED PLACE: its canonical top sits DIRECTLY under the operator's
//       declared lane-worktree parent (lane-worktree-root.js::laneWorktreeRoot,
//       key `laneWorktreeRoot` in loom-links.local.json). No declaration ⇒ no
//       linked worktree is a member — every consumer repo, by design;
//   (1) `<top>/.git` is a regular file `gitdir: <G>`;
//   (2) realpath(<G>/commondir) === the installed root's real common dir;
//   (3) dirname(realpath(G)) === <common>/worktrees — a LOCATION check: the
//       gitdir sits where git keeps the registrations it writes, so a
//       self-consistent forged gitdir ELSEWHERE (carrying its own commondir +
//       back-pointer) cannot qualify;
//   (4) BACK-POINTER: realpath(<G>/gitdir) === realpath(<top>/.git) — so a
//       forged `.git` file naming a REAL registered gitdir is refused, because
//       that gitdir points back at its own worktree, not at the forgery.
// Both sides of every comparison go through the same resolver (canonicalPath).
//
// WHY (0) EXISTS. Conditions (1)-(4) cannot tell WHO registered a worktree:
// `git worktree add <any path>` makes a REAL registration that passes all four,
// `git worktree repair` re-points a back-pointer at an existing directory, and
// a hand-written `<common>/worktrees/<x>/{commondir,gitdir}` is indistinguishable
// from either. The `.git` write fence (guard-path-scope.js::PROTECTED_PATHS, row
// id ".git") is a LEXICAL match on the command text and does not stop the git
// commands that write there. Without (0), membership — and with it typed
// Write/Edit acceptance — reached ANY directory anyone ever registered. (0)
// bounds it to the operator's declared place; a registration anywhere else,
// real or forged, in the root or out of it, is not a member.
//
// RESIDUAL, MEASURED, NOT CLOSED HERE: SHELL writes outside the installed root
// are unfenced on both CLIs (validate-bash-command.js's state-file fence names
// specific paths; nothing refuses `echo x > /elsewhere` or
// `git worktree add /elsewhere`). This predicate bounds the TYPED-edit route
// only, and who may write the declaration itself is likewise not fenced here.
// Pinned in codex-native-policy.test.mjs.

const POINTER_MAX = 4096;

// Every canonical path in this module comes from realpathSync.NATIVE. The JS
// realpathSync only resolves symlinks and keeps the TYPED case, so on a
// case-insensitive filesystem (macOS, Windows defaults) `SRC/file.txt` stayed
// `SRC/file.txt` and evaded an `src/**` rule; native realpath returns the
// on-disk case. (Declared here, used above: every caller runs after load.)
const canonicalPath = (p) => fs.realpathSync.native(p);

/** The POSIX forms a rule glob is matched against for absolute path `p`:
 *  relative to the checkout that holds it, AND — when `p` is inside the
 *  installed root — relative to the root as well. Condition (0) already keeps
 *  every linked top OUT of the root (the declared parent may not lie inside
 *  it); the second form is the independent backstop, so a checkout nested in
 *  the root could only ADD rules, never re-anchor `src/**` away from
 *  `src/file.txt`. Empty when `p` is in no checkout of the installed repo. */
function matchForms(root, p) {
  const top = checkoutTop(root, p);
  if (!top) return [];
  const bases = new Set([top, ...(within(root, p) ? [root] : [])]);
  return [...bases].map(base => path.relative(base, p).split(path.sep).join("/"));
}

function readPointer(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > POINTER_MAX) return null;
    const buffer = Buffer.alloc(POINTER_MAX + 1);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (n > POINTER_MAX) return null;
    const text = buffer.subarray(0, n).toString("utf8").replace(/\r?\n$/, "");
    return text && !/[\0\r\n]/.test(text) ? text : null;
  } finally { fs.closeSync(fd); }
}

/** The real git common dir of the checkout whose top is `top`, or null. */
function checkoutCommonDir(top) {
  try {
    const dotGit = path.join(top, ".git");
    const stat = fs.lstatSync(dotGit);
    if (stat.isDirectory()) return canonicalPath(dotGit); // a main worktree IS its common dir
    if (!stat.isFile()) return null; // symlinked `.git` (or anything else) is refused
    const pointer = readPointer(dotGit);
    const match = pointer && /^gitdir: (.+)$/.exec(pointer);
    if (!match) return null;
    const gitdir = canonicalPath(path.resolve(top, match[1]));
    const commonText = readPointer(path.join(gitdir, "commondir"));
    if (!commonText) return null;
    const common = canonicalPath(path.resolve(gitdir, commonText));
    // Location only, not provenance — see WHY (0) EXISTS above.
    if (path.dirname(gitdir) !== path.join(common, "worktrees")) return null;
    const back = readPointer(path.join(gitdir, "gitdir"));
    if (!back || canonicalPath(path.resolve(gitdir, back)) !== canonicalPath(dotGit)) return null;
    return common;
  } catch (error) { return notAMember(top, error); }
}

// An ABSENT piece (ENOENT/ENOTDIR) or a refused symlink (ELOOP, from
// O_NOFOLLOW) is a definite "not a member". Any OTHER failure (EACCES,
// ENAMETOOLONG, EIO, ...) means membership could not be DECIDED: it still
// refuses, but under its own reason, so it is never reported as "outside the
// installed repository" (or, inside the root, silently read as root).
const NOT_A_MEMBER_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
function notAMember(where, error) {
  if (NOT_A_MEMBER_CODES.has(error?.code)) return null;
  throw new Error(`checkout membership could not be decided at ${where}: ${error?.code || error?.message || error}`);
}

/** The top of the installed repository's checkout containing `candidate`
 *  (absolute; trailing components may not exist yet), or null when it lies in
 *  none. The NEAREST `.git` above the candidate decides; a nearest `.git` that
 *  is not a verified member falls back to plain containment in `root`, which
 *  preserves the previous behaviour for in-tree nested repositories. */
function checkoutTop(rootInput, candidate) {
  // The root is canonicalized here, by the SAME resolver as every top found
  // below, so no caller's resolver choice can make the comparisons disagree.
  let root;
  try { root = canonicalPath(rootInput); } catch (error) { if (notAMember(rootInput, error) === null) return null; }
  const rootCommon = checkoutCommonDir(root);
  for (let dir = candidate; ; ) {
    let found = false;
    try { fs.lstatSync(path.join(dir, ".git")); found = true; } catch (error) { notAMember(dir, error); /* absent: keep walking */ }
    if (found) {
      if (rootCommon !== null && checkoutCommonDir(dir) === rootCommon && canonicalPath(dir) === dir && (dir === root || isDeclaredLane(root, dir))) return dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return within(root, candidate) ? root : null;
}

/** Condition (0): canonical linked top `dir` sits DIRECTLY under the declared parent. */
function isDeclaredLane(root, dir) {
  const parent = require("./lane-worktree-root").laneWorktreeRoot(root);
  return parent !== null && path.dirname(dir) === parent;
}

module.exports = { collectRuleContext, targetPath, readOrdinary, checkoutTop, checkoutCommonDir };
