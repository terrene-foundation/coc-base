#!/usr/bin/env node
/**
 * coc-run.mjs — neutral `.coc/` launcher (community Level-1 floor).
 *
 * W3 of the coc-universal workstream (workspaces/coc-universal: decisions/00
 * D1; wave-plan W3; contract specs/09b-coc-to-surface-conversion.md §12). This
 * is loom's **Level-1 reference implementation** of the `.coc/`→surface
 * conversion contract — the COMMUNITY conformer that lets ANY supported CLI run
 * in a `.coc/`-only repo WITHOUT the enterprise runtime (csq). It is the
 * byte-parity counterparty to csq's L1 translation (contract §10.2).
 *
 * Pipeline (contract §12 "coc-run" row):
 *   resolve .coc/  →  verify integrity (COC.lock)  →  translate (L1 flatten)
 *   →  materialize an EPHEMERAL OUT-OF-REPO config home + inject the flattened
 *      surface  →  spawn the CLI pointed at that home  →  reclaim on exit.
 *
 * ZERO REPO FILES (contract §0): the only bytes this tool writes live in an
 * `os.tmpdir()` scratch dir reclaimed on exit. It never writes into `.coc/`,
 * the cwd, or the repo tree.
 *
 * STANDALONE (load-bearing): a `.coc/`-only consumer repo has NO `.claude/`
 * tree and NO sync-manifest.yaml. This launcher therefore imports ONLY Node
 * built-ins — it MUST NOT depend on loom's producer libs (`lib/coc-manifest.mjs`,
 * `emit*.mjs`), which read `.claude/`. The launcher reads a FINISHED `.coc/`
 * tree, the same artifact a downstream consumer carries.
 *
 * Surface fidelity (contract §2): this is the **Axis-A Level-1 floor** — every
 * kind flattens to injected prose into each CLI's single directive field
 * (rules → system prompt; agents/skills/commands → inlined descriptive prose).
 * Native L2 (dispatchable subagents, native /commands, progressive-disclosure
 * skills) and the Axis-B nested/path-scoped N1 dynamic-injection layer are
 * SEPARATE mechanisms above this floor (contract §4/§5/§8) — out of W3 scope.
 *
 * Usage:
 *   node .claude/bin/coc-run.mjs --cli <cc|codex|gemini> [--coc <dir>] \
 *        [--print | --dry-run] [--bin <path>] [--no-verify-lock] [-- <cli args>]
 *
 *   --cli           target CLI surface (required): cc|claude-code, codex, gemini
 *   --coc <dir>     path to the .coc/ directory (default: <cwd>/.coc)
 *   --print         emit the L1-flattened surface to stdout; do NOT spawn
 *   --dry-run       emit the resolved spawn plan (surface, env, argv, inject
 *                   target) to stdout; do NOT spawn
 *   --bin <path>    override the CLI binary (default: the surface's default bin)
 *   --no-verify-lock  skip the COC.lock integrity check (dev only; logged)
 *   -- <cli args>   everything after `--` is passed through to the CLI verbatim
 *
 * Node ESM, zero external deps.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ──────────────────────────────────────────────────────────────────
// CLI surface registry (contract §5 config-home matrix + §7 baselines).
// ──────────────────────────────────────────────────────────────────
// Each surface maps to: the canonical `applies_to` token (§6), the
// out-of-repo config-home ENV var the CLI honors (§5 — cited inline), the
// in-home file the L1 surface is injected into, and the default binary name.
//
// CITATION + DEFERRAL DISCIPLINE (evidence-first):
//   - The config-home ENV vars are taken from contract §5's per-CLI matrix
//     (CC: CLAUDE_CONFIG_DIR — PARTIAL/OAuth caveat; Codex: CODEX_HOME — YES;
//     Gemini: GEMINI_CLI_HOME — YES). The §7 project-local baseline filenames
//     are CLAUDE.md / AGENTS.md / GEMINI.md.
//   - The (config-home ENV × inject-file) PAIRING is THIS launcher's L1
//     injection design — the deterministic translation + wiring is W3's
//     verifiable contribution. Whether each real CLI binary consumes the file
//     at that path is a BEHAVIORAL fact confirmed at the W4 behavior-parity
//     gate (csq owns coc-eval; contract §10.2) — NOT asserted as verified here.
//     The `injectFile` constant is the single reconciliation point if W4
//     surfaces a different read path for a given CLI.
const SURFACES = {
  cc: {
    token: "claude-code",
    aliases: ["cc", "claude", "claude-code"],
    configHomeEnv: "CLAUDE_CONFIG_DIR",
    injectFile: "CLAUDE.md",
    surfaceField: "system-prompt",
    defaultBin: "claude",
  },
  codex: {
    token: "codex",
    aliases: ["codex"],
    configHomeEnv: "CODEX_HOME",
    injectFile: "AGENTS.md",
    surfaceField: "instructions",
    defaultBin: "codex",
  },
  gemini: {
    token: "gemini",
    aliases: ["gemini"],
    configHomeEnv: "GEMINI_CLI_HOME",
    injectFile: "GEMINI.md",
    surfaceField: "system_instruction",
    defaultBin: "gemini",
  },
};

const KINDS = ["rules", "agents", "skills", "commands"];

// ──────────────────────────────────────────────────────────────────
// Surface resolution.
// ──────────────────────────────────────────────────────────────────
// Map a user `--cli` token (alias-tolerant) to a SURFACES entry. Returns the
// surface key (cc/codex/gemini) or throws a usage error naming the valid set.
function resolveSurface(cli) {
  if (!cli) {
    throw new UsageError("missing --cli <cc|codex|gemini>");
  }
  const norm = String(cli).toLowerCase();
  for (const [key, s] of Object.entries(SURFACES)) {
    if (s.aliases.includes(norm)) return key;
  }
  throw new UsageError(
    `unknown --cli '${cli}' — valid: cc|claude-code, codex, gemini`,
  );
}

// ──────────────────────────────────────────────────────────────────
// Frontmatter parsing — minimal strict-YAML reader for the loom-emitted
// `.coc/` block ({id, paths?, applies_to?, name?, description?, ...}).
// ──────────────────────────────────────────────────────────────────
// The launcher needs only the scalar fields it FRAMES the L1 prose with
// (id, name, description) plus the two list fields it SCOPES on (applies_to,
// paths). The L2-ONLY typed fields (tools/model/hooks) are NOT parsed here —
// only name/description are read (they ARE §3.2 typed fields, but used solely
// to frame the L1 heading/subheading, never to reconstruct native L2
// structure); the artifact body is injected verbatim regardless.
//
// Returns { fields, body }. `fields` carries: id (string), name (string|null),
// description (string|null), appliesTo (string[]|null), paths (string[]|null).
function parseArtifact(source, relForError) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    throw new CocError(
      `malformed artifact ${relForError}: missing leading '---' frontmatter fence`,
    );
  }
  const rawFm = m[1];
  const body = source.slice(m[0].length);
  const fields = {
    id: scalarField(rawFm, "id"),
    name: scalarField(rawFm, "name"),
    description: scalarField(rawFm, "description"),
    appliesTo: listField(rawFm, "applies_to"),
    paths: listField(rawFm, "paths"),
  };
  if (!fields.id) {
    throw new CocError(
      `malformed artifact ${relForError}: required 'id' field absent from frontmatter`,
    );
  }
  return { fields, body };
}

// Read a single-line scalar `key: value` / `key: "value"` from raw frontmatter.
// Returns the unquoted string or null when the key is absent. Only matches at
// column 0 (a nested `  key:` under `hooks:` is NOT a top-level field).
function scalarField(rawFm, key) {
  const re = new RegExp(`^${escapeRe(key)}:[ \\t]+(.+?)[ \\t]*$`, "m");
  const mm = rawFm.match(re);
  if (!mm) return null;
  return unquoteScalar(mm[1]);
}

// Read a YAML flow-sequence list field `key: [a, "b,c"]` from raw frontmatter.
// Returns string[] or null when absent. STRUCTURAL DEPENDENCY: emit-coc's
// buildFrontmatter (emit-coc.mjs) emits paths/applies_to as single-line FLOW
// sequences ONLY — never the YAML block form (`paths:\n  - a`). If that ever
// changes, listField MUST gain a block reader or path-scope annotations +
// applies_to filtering would silently read null (a quiet fidelity loss, not a
// crash). The two sides MUST stay in lockstep.
function listField(rawFm, key) {
  const re = new RegExp(`^${escapeRe(key)}:[ \\t]*\\[(.*)\\][ \\t]*$`, "m");
  const mm = rawFm.match(re);
  if (!mm) return null;
  return splitFlowItems(mm[1]);
}

// Tokenize a YAML flow-sequence interior (`a, "b,c", 'd'`) into raw items,
// respecting quotes so a comma INSIDE a quoted scalar is not a separator.
// (Mirrors emit-coc.mjs::splitFlowItems so the consume side matches the
// produce side.)
function splitFlowItems(inner) {
  const items = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      items.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function unquoteScalar(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    // Undo the double-quote escaping emit-coc's yamlQuote applies (\\ and \").
    return t
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return t;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ──────────────────────────────────────────────────────────────────
// COC.lock integrity verification (contract §9 determinism + spec §9.2.5).
// ──────────────────────────────────────────────────────────────────
// The lock is `{schema_version, files:[{path, sha256}]}`, sorted by path,
// covering every file under .coc/ EXCEPT COC.lock itself. Verify recomputes
// each listed file's sha256 and asserts (a) the file exists, (b) the hash
// matches, and (c) no listed-but-absent / present-but-unlisted drift. Any
// mismatch is fail-loud (zero-tolerance Rule 3 — never a silent fallback):
// a tampered or partially-written `.coc/` MUST halt, not inject garbage.
function verifyLock(cocDir) {
  const lockPath = path.join(cocDir, "COC.lock");
  if (!fs.existsSync(lockPath)) {
    throw new CocError(
      `integrity: ${rel(cocDir)}/COC.lock not found — cannot verify the .coc/ set ` +
        `(re-emit, or pass --no-verify-lock to skip at your own risk)`,
    );
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (e) {
    throw new CocError(`integrity: COC.lock is not valid JSON — ${e.message}`);
  }
  if (!lock || !Array.isArray(lock.files)) {
    throw new CocError(
      `integrity: COC.lock missing the 'files' array (schema_version=${lock?.schema_version})`,
    );
  }
  const listed = new Set();
  for (const entry of lock.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      throw new CocError(`integrity: COC.lock has a malformed file entry: ${JSON.stringify(entry)}`);
    }
    assertSafeLockPath(entry.path);
    listed.add(entry.path);
    const abs = path.join(cocDir, entry.path);
    // Defense in depth: even after the path-shape check, assert the joined path
    // stays inside cocDir (rejects any residual escape).
    if (path.resolve(abs) !== path.resolve(cocDir) && !path.resolve(abs).startsWith(path.resolve(cocDir) + path.sep)) {
      throw new CocError(`integrity: COC.lock entry.path '${entry.path}' resolves outside the .coc/ tree — refusing`);
    }
    if (!fs.existsSync(abs)) {
      throw new CocError(
        `integrity: COC.lock lists ${entry.path} but it is absent from ${rel(cocDir)} (incomplete set)`,
      );
    }
    // O_NOFOLLOW read: a listed entry that is a symlink is tampering (ELOOP →
    // CocError), closing the symlink-bypass paired with the walk's drift check.
    const got = sha256Hex(readFileNoFollow(abs, entry.path));
    if (got !== entry.sha256) {
      throw new CocError(
        `integrity: hash mismatch for ${entry.path}\n  expected ${entry.sha256}\n  got      ${got}\n` +
          `  the .coc/ set is tampered or partially written — refusing to inject`,
      );
    }
  }
  // Drift the other way: a present-but-unlisted file under a kind dir would be
  // silently injected with no integrity coverage. Surface it (the COC.lock
  // covers EVERY .coc/ file except itself, per emit-coc buildLock).
  for (const { rel: r } of walkCocFiles(cocDir)) {
    if (r === "COC.lock") continue;
    if (!listed.has(r)) {
      throw new CocError(
        `integrity: ${r} exists under ${rel(cocDir)} but is NOT listed in COC.lock ` +
          `(unverified file — refusing to inject)`,
      );
    }
  }
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Read a .coc/ file refusing to follow a final-component symlink (O_NOFOLLOW).
// emit-coc NEVER emits symlinks (it writes with O_NOFOLLOW), so any symlinked
// artifact in a .coc/ set is tampering — and a symlinked `.md` is an integrity
// BYPASS vector: the COC.lock drift check's directory walk would skip a symlink
// Dirent (neither file nor dir), yet a naive readFileSync would FOLLOW it and
// inject the link target's content. O_NOFOLLOW raises ELOOP on a symlinked
// leaf; the `|| 0` degrades to a plain read where the flag is unavailable
// (Windows), where the callers' lstat checks are the backstop.
function readFileNoFollow(abs, relForError) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(abs, flags);
  } catch (e) {
    if (e && e.code === "ELOOP") {
      // ELOOP is the errno O_NOFOLLOW raises when the final component IS a
      // symlink (EMLINK is the unrelated too-many-hardlinks errno — not a
      // symlink-refusal signal, so it is NOT caught here).
      throw new CocError(
        `integrity: ${relForError} is a symlink — refusing to follow it out of the .coc/ set ` +
          `(emit-coc never emits symlinks; a symlinked artifact is tampering)`,
      );
    }
    throw e;
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Validate a COC.lock `files[].path` is an in-tree, relative, posix path before
// it is joined onto cocDir and read. A hostile lock could otherwise list
// `../../../etc/passwd` (an out-of-tree read-and-hash oracle) or an absolute
// path (a DoS via `/dev/zero`). emit-coc only ever emits posix-relative in-tree
// paths, so this rejects ONLY malicious locks.
function assertSafeLockPath(entryPath) {
  if (entryPath.includes("\0")) {
    throw new CocError(`integrity: COC.lock entry.path contains a NUL byte — refusing`);
  }
  if (entryPath.includes("\\")) {
    throw new CocError(`integrity: COC.lock entry.path '${entryPath}' contains a backslash (non-posix) — refusing`);
  }
  if (path.isAbsolute(entryPath)) {
    throw new CocError(`integrity: COC.lock entry.path '${entryPath}' is absolute — refusing`);
  }
  const norm = path.posix.normalize(entryPath);
  if (norm === ".." || norm.startsWith("../")) {
    throw new CocError(`integrity: COC.lock entry.path '${entryPath}' escapes the .coc/ tree — refusing`);
  }
}

// Walk every file under .coc/ yielding posix-relative paths. A symlink Dirent
// (file OR dir) is fail-loud: a symlinked entry is the integrity-BYPASS vector
// this drift check exists to catch (a naive walk skips a symlink Dirent, then
// the reader follows it). readdirSync(withFileTypes) does NOT follow links, so
// isSymbolicLink() correctly classifies the link itself.
function* walkCocFiles(cocDir, sub = "") {
  const dir = sub ? path.join(cocDir, sub) : cocDir;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relP = sub ? `${sub}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) {
      throw new CocError(
        `integrity: ${relP} under ${rel(cocDir)} is a symlink — refusing ` +
          `(a symlinked entry bypasses the COC.lock drift check)`,
      );
    }
    if (ent.isDirectory()) {
      yield* walkCocFiles(cocDir, relP);
    } else if (ent.isFile()) {
      yield { rel: relP };
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Load the `.coc/` set into records.
// ──────────────────────────────────────────────────────────────────
// Returns { cocVersion, records } where each record is
// { kind, id, fields, body }, records sorted by (kind-order, id) for a
// deterministic translation. Reads COC.md for the version envelope (§9).
function loadCocSet(cocDir) {
  if (!fs.existsSync(cocDir) || !fs.statSync(cocDir).isDirectory()) {
    throw new CocError(`no .coc/ directory at ${rel(cocDir)}`);
  }
  // COC.md is read with the SAME O_NOFOLLOW posture as every artifact (a
  // symlinked COC.md is the one read that would otherwise escape loadCocSet's
  // "independently strict" guarantee — under --no-verify-lock it would be an
  // out-of-tree read oracle + a comment-break injection vector via cocVersion).
  const cocMdPath = path.join(cocDir, "COC.md");
  let cocVersion = null;
  let cocMdRaw = null;
  try {
    cocMdRaw = readFileNoFollow(cocMdPath, "COC.md").toString("utf8");
  } catch (e) {
    if (e instanceof CocError) throw e; // symlinked COC.md → fail loud
    if (e.code !== "ENOENT") throw e; // real I/O fault → fail loud; ENOENT → COC.md is optional
  }
  if (cocMdRaw !== null) {
    const fm = cocMdRaw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const vm = fm[1].match(/^coc\.version:[ \t]*(.+?)[ \t]*$/m);
      if (vm) cocVersion = sanitizeVersion(vm[1].trim());
    }
  }
  const records = [];
  for (const kind of KINDS) {
    const kindDir = path.join(cocDir, kind);
    // lstat (not stat): a symlinked KIND dir is refused (it would redirect the
    // readdir out of the .coc/ tree). Absent kind dir → skip. Independent of
    // verifyLock so the --no-verify-lock path + direct callers stay strict.
    let dst;
    try {
      dst = fs.lstatSync(kindDir);
    } catch (e) {
      if (e.code === "ENOENT") continue; // kind dir absent (legitimate — not every .coc/ has all 4 kinds)
      throw new CocError(`malformed .coc/: cannot stat kind dir '${kind}' — ${e.message}`); // EACCES / I/O → fail loud
    }
    if (dst.isSymbolicLink()) {
      throw new CocError(`malformed .coc/: kind dir '${kind}' is a symlink — refusing`);
    }
    if (!dst.isDirectory()) continue;
    const ents = fs
      .readdirSync(kindDir, { withFileTypes: true })
      .filter((e) => e.name.endsWith(".md"))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of ents) {
      const relForError = `${kind}/${ent.name}`;
      if (ent.isSymbolicLink()) {
        throw new CocError(`malformed artifact ${relForError}: is a symlink — refusing to follow`);
      }
      const { fields, body } = parseArtifact(
        readFileNoFollow(path.join(kindDir, ent.name), relForError).toString("utf8"),
        relForError,
      );
      records.push({ kind, id: fields.id, fields, body });
    }
  }
  return { cocVersion, records };
}

// ──────────────────────────────────────────────────────────────────
// Surface filter (contract §6 applies_to semantics).
// ──────────────────────────────────────────────────────────────────
// applies_to OMITTED = universal → delivered on every surface. Present = a
// surface allowlist → delivered only when the surface token is a member.
// Unknown tokens (a future surface) simply don't match → excluded for this
// CLI (forward-compatible, never a throw — mirrors csq §9 unknowns-tolerance).
// Per contract §6 a universal artifact has "empty/absent applies_to" — so BOTH
// an absent field (null) AND an empty array [] are universal (delivered on every
// surface). emit-coc never emits []  (computeAppliesTo returns null for
// universal), but coc-run is csq's §10.2 byte-parity counterparty: matching the
// contract's literal "empty = universal" wording keeps the two conformers from
// disagreeing on this input.
function filterForSurface(records, surfaceToken) {
  return records.filter(
    (r) =>
      r.fields.appliesTo === null ||
      r.fields.appliesTo.length === 0 ||
      r.fields.appliesTo.includes(surfaceToken),
  );
}

// Strip the HTML-comment-closing token from a version string before it is
// interpolated into the L1 header comment (translateL1). A loom-authored,
// hash-pinned COC.md never contains `-->`, so this is a no-op on every real
// input (byte-parity with csq preserved) — it closes the comment-break vector
// only on a tampered/symlinked COC.md read under --no-verify-lock.
function sanitizeVersion(v) {
  return String(v).replace(/--+>/g, "");
}

// ──────────────────────────────────────────────────────────────────
// L1 translation (contract §4 — the "L1 target (injection)" column).
// ──────────────────────────────────────────────────────────────────
// Flatten the surface-filtered records into ONE deterministic prose blob, the
// byte-parity counterparty to csq's L1 translation (§10.2). Framing:
//   - rules    → body verbatim (a rule IS system-prompt context; full fidelity
//                per §2). A path-scoped rule carries a one-line scope note so
//                the location-scope survives the static injection (the Axis-B
//                N1 dynamic refinement is a separate layer — §8).
//   - agents   → inlined descriptive prose (NOT a dispatchable subagent at L1).
//   - skills   → inlined prose, full body (NO progressive disclosure at L1).
//   - commands → inlined procedure (NOT invocable as /command at L1).
// Records are pre-sorted (kind-order, id); a kind with zero applicable
// artifacts is omitted. Output is LF-only with a trailing newline, so the same
// `.coc/` + surface yields byte-identical output across runs and machines
// (contract §9 determinism).
//
// NOTE (W4 reconciliation): loom owns the conversion BEHAVIOR (contract §0), so
// this framing IS the canonical L1 contract; the W4 byte-parity golden asserts
// csq's L1 translation matches it. The framing constants below are the single
// reconciliation surface if W4 surfaces a delta.
const KIND_HEADINGS = {
  rules: "## Rules",
  agents: "## Agents (inlined as descriptive prose; not dispatchable at Level 1)",
  skills: "## Skills (inlined in full; progressive disclosure unavailable at Level 1)",
  commands: "## Commands (inlined as procedures; not invocable as /command at Level 1)",
};

function translateL1(records, { surfaceToken, cocVersion }) {
  const lines = [];
  // sanitizeVersion at the interpolation point (defense in depth — loadCocSet
  // already sanitizes the stored value): a `-->` in the version can never close
  // the header comment and inject prose, regardless of the caller. No-op on a
  // legit version, so the §10.2 byte-parity golden is unaffected.
  lines.push(
    `<!-- coc-run Level-1 injection · surface=${surfaceToken} · coc.version=${sanitizeVersion(cocVersion ?? "unknown")} -->`,
  );
  lines.push(
    "<!-- Deterministic flatten of .coc/ by the neutral coc-run launcher. " +
      "Rules are full-fidelity context; agents/skills/commands are inlined descriptive prose. -->",
  );

  for (const kind of KINDS) {
    const inKind = records.filter((r) => r.kind === kind);
    if (inKind.length === 0) continue;
    lines.push("");
    lines.push(KIND_HEADINGS[kind]);
    for (const rec of inKind) {
      lines.push("");
      lines.push(artifactHeading(rec));
      const sub = artifactSubheading(rec);
      if (sub) lines.push(sub);
      lines.push("");
      // CANONICAL WHITESPACE CONTRACT (the byte-parity reference csq matches at
      // W4): heading, EXACTLY ONE blank line, then the body trimmed at BOTH ends.
      // Trimming LEADING whitespace is load-bearing — an emit-coc body arrives as
      // "\n<content>" (the producer writes `<fm>\n\n<body>`), so without the
      // leading trim every artifact would render an INCIDENTAL second blank line.
      // Trimming makes the single-blank framing INTENTIONAL, not accidental.
      lines.push(rec.body.replace(/^\s+/, "").replace(/\s+$/, ""));
    }
  }
  return lines.join("\n") + "\n";
}

function artifactHeading(rec) {
  if (rec.kind === "rules") {
    const scope =
      rec.fields.paths && !isUniversalPaths(rec.fields.paths)
        ? ` — applies to paths: ${rec.fields.paths.join(", ")}`
        : "";
    return `### Rule: ${rec.id}${scope}`;
  }
  const label = { agents: "Agent", skills: "Skill", commands: "Command" }[rec.kind];
  const handle = rec.fields.name ? `${rec.fields.name} (${rec.id})` : rec.id;
  return `### ${label}: ${handle}`;
}

function artifactSubheading(rec) {
  if (rec.kind === "rules") return null;
  return rec.fields.description ? `_${rec.fields.description}_` : null;
}

// A path set counts as universal (→ no scope annotation in the L1 heading) when
// every glob is one of the two universal spellings. BYTE-PARITY COUPLING: this
// predicate MUST stay byte-aligned with csq's universal-paths predicate — the
// annotation it gates is part of the §10.2 L1 golden, so a divergence (one
// conformer treating a third universal-equivalent glob as universal, the other
// not) would surface as a byte-parity diff on the heading line. The contract §6
// default is `["**"]`; emit-coc only emits globs the source rule declared, so
// the set {`**`, `**/*`} is complete today. (Same front-loaded-coupling note as
// listField's STRUCTURAL DEPENDENCY comment.)
function isUniversalPaths(paths) {
  return paths.every((p) => p === "**" || p === "**/*");
}

// ──────────────────────────────────────────────────────────────────
// Ephemeral out-of-repo materialization + cleanup (contract §0 zero-repo-files).
// ──────────────────────────────────────────────────────────────────
// Create a scratch dir under os.tmpdir() (NEVER inside the repo), write the L1
// surface into the per-surface inject file, and return { dir, file }. The
// caller reclaims the dir in its finally block (the load-bearing guarantee,
// since the spawn is synchronous), with a process 'exit' + signal-handler
// backstop for the pre/post-spawn window (see run()).
function materializeEphemeral(blob, surfaceKey) {
  const surface = SURFACES[surfaceKey];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-run-"));
  const file = path.join(dir, surface.injectFile);
  fs.writeFileSync(file, blob, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

// Idempotent recursive removal of an ephemeral dir. Best-effort: a cleanup
// failure must never mask the underlying exit code.
function reclaim(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort: never let cleanup mask the real exit status */
  }
}

// ──────────────────────────────────────────────────────────────────
// Spawn-plan construction.
// ──────────────────────────────────────────────────────────────────
// Build { cmd, args, env } for the CLI launch: env injects the surface's
// config-home var pointing at the ephemeral dir; argv is the passthrough.
// Pure — no spawn — so it is fully unit-testable and is the --dry-run surface.
function buildSpawn(surfaceKey, ephemeralDir, { bin, passthrough }) {
  const surface = SURFACES[surfaceKey];
  return {
    cmd: bin || surface.defaultBin,
    args: passthrough.slice(),
    env: { ...process.env, [surface.configHomeEnv]: ephemeralDir },
  };
}

// ──────────────────────────────────────────────────────────────────
// Errors + small helpers.
// ──────────────────────────────────────────────────────────────────
class UsageError extends Error {}
class CocError extends Error {}

function rel(p) {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r || ".";
}

// ──────────────────────────────────────────────────────────────────
// Arg parsing.
// ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    cli: null,
    coc: null,
    print: false,
    dryRun: false,
    bin: null,
    verifyLock: true,
    passthrough: [],
  };
  // A value-taking flag whose next token is another flag (or absent) is a
  // missing value, not a value — fail loud rather than silently consuming the
  // next flag (e.g. `--cli --print` must not treat `--print` as the CLI).
  const takeValue = (flag, next) => {
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`missing value for ${flag}`);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.passthrough = argv.slice(i + 1);
      break;
    } else if (a === "--cli") args.cli = takeValue(a, argv[++i]);
    else if (a === "--coc") args.coc = takeValue(a, argv[++i]);
    else if (a === "--print") args.print = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--bin") args.bin = takeValue(a, argv[++i]);
    else if (a === "--no-verify-lock") args.verifyLock = false;
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new UsageError(`unknown argument '${a}'`);
  }
  if (args.print && args.dryRun) {
    throw new UsageError(`--print and --dry-run are mutually exclusive`);
  }
  return args;
}

const USAGE = `usage: coc-run.mjs --cli <cc|codex|gemini> [--coc <dir>] [--print|--dry-run] [--bin <path>] [--no-verify-lock] [-- <cli args>]`;

// ──────────────────────────────────────────────────────────────────
// Orchestration. Returns an exit code.
// ──────────────────────────────────────────────────────────────────
export function run(argv, { spawn = spawnSync } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`coc-run: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  let surfaceKey;
  try {
    surfaceKey = resolveSurface(args.cli);
  } catch (e) {
    process.stderr.write(`coc-run: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  const surface = SURFACES[surfaceKey];

  const cocDir = path.resolve(args.coc || path.join(process.cwd(), ".coc"));

  // ACCEPTED bounded-trust residuals (the integrity gate is defense-in-depth
  // against a partially-written / tampered set, NOT a sandbox boundary — the
  // launcher runs inside the consumer repo's own filesystem trust domain):
  //  (1) verify→load window: verifyLock hashes each file, then loadCocSet
  //      RE-READS them — a `.coc/`-writable adversary could swap a file (incl.
  //      COC.md, which verifyLock hashes via the lock and loadCocSet re-reads
  //      with the same O_NOFOLLOW posture) in that window. O_NOFOLLOW on BOTH
  //      reads blocks the symlink-class escalation; the swap needs `.coc/` write
  //      access, which already controls the input.
  //  (2) cocDir-ROOT symlink: a symlinked `.coc/` ROOT passed via --coc is
  //      FOLLOWED (statSync/readdirSync), where every IN-TREE symlink (artifact,
  //      kind dir, COC.md) is refused. This is invoker-controlled (--coc is the
  //      caller's own argument, not hostile `.coc/`-tree content), so it crosses
  //      no privilege boundary — a deliberate carve-out so "my .coc is a symlink
  //      to elsewhere" stays a valid invocation while the bypass-vector symlinks
  //      INSIDE the set remain fail-loud.
  let cocVersion, records;
  try {
    if (args.verifyLock) verifyLock(cocDir);
    else process.stderr.write(`coc-run: WARNING — COC.lock integrity check skipped (--no-verify-lock)\n`);
    ({ cocVersion, records } = loadCocSet(cocDir));
  } catch (e) {
    if (e instanceof CocError) {
      process.stderr.write(`coc-run: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const filtered = filterForSurface(records, surface.token);
  const blob = translateL1(filtered, { surfaceToken: surface.token, cocVersion });

  // --print: emit the L1 surface; no spawn, no materialization, zero files.
  if (args.print) {
    process.stdout.write(blob);
    return 0;
  }

  // --dry-run: emit the resolved plan; no spawn. Materialize so the inject
  // path is real, then reclaim immediately (still zero PERSISTENT files).
  if (args.dryRun) {
    const eph = materializeEphemeral(blob, surfaceKey);
    try {
      const plan = buildSpawn(surfaceKey, eph.dir, { bin: args.bin, passthrough: args.passthrough });
      process.stdout.write(
        [
          `surface:        ${surface.token} (${surfaceKey})`,
          `coc.version:    ${cocVersion ?? "unknown"}`,
          `coc dir:        ${cocDir}`,
          `artifacts:      ${filtered.length}/${records.length} (after applies_to filter)`,
          `inject file:    ${eph.file}`,
          `config-home env:${surface.configHomeEnv}=${eph.dir}`,
          `spawn:          ${plan.cmd} ${plan.args.join(" ")}`.trimEnd(),
        ].join("\n") + "\n",
      );
      return 0;
    } finally {
      reclaim(eph.dir);
    }
  }

  // Spawn path. Reclaim is layered:
  //   - the finally block ALWAYS runs (spawnSync is synchronous) → it is the
  //     load-bearing reclaim for the normal + error + post-signal-return paths;
  //   - the 'exit' handler backstops an exit between materialize and the finally;
  //   - the SIGINT/SIGTERM handlers cover only the narrow pre/post-spawn JS
  //     window. DURING the spawnSync child run the event loop is BLOCKED so they
  //     cannot fire — but the child runs with inherited stdio and receives the
  //     terminal signal directly, then spawnSync returns and the finally reclaims.
  // ALL handlers are DEREGISTERED in the finally so repeated in-process run()
  // calls (run() is exported — e.g. a coc-eval driver) do not leak listeners.
  const eph = materializeEphemeral(blob, surfaceKey);
  let reclaimed = false;
  const doReclaim = () => {
    if (reclaimed) return;
    reclaimed = true;
    reclaim(eph.dir);
  };
  const onInt = () => {
    doReclaim();
    process.exit(130); // 128 + SIGINT(2)
  };
  const onTerm = () => {
    doReclaim();
    process.exit(143); // 128 + SIGTERM(15)
  };
  process.on("exit", doReclaim);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  try {
    const plan = buildSpawn(surfaceKey, eph.dir, { bin: args.bin, passthrough: args.passthrough });
    const res = spawn(plan.cmd, plan.args, { env: plan.env, stdio: "inherit" });
    if (res.error) {
      if (res.error.code === "ENOENT") {
        process.stderr.write(
          `coc-run: CLI binary '${plan.cmd}' not found on PATH ` +
            `(override with --bin <path>)\n`,
        );
        return 127;
      }
      process.stderr.write(`coc-run: failed to spawn '${plan.cmd}': ${res.error.message}\n`);
      return 1;
    }
    if (res.status != null) return res.status;
    // A signal-terminated child (segfault/SIGSEGV, OOM-kill/SIGKILL, abort) sets
    // status=null + signal=<name>. Mapping that to 0 would report a CRASHED CLI
    // as success to a consumer of the exported run() (e.g. the §10.2 coc-eval /
    // byte-parity driver) — a zero-tolerance Rule 3 silent-error-hide. Surface
    // it as the shell-conventional 128+signal, matching the 130/143 the SIGINT/
    // SIGTERM handlers already use.
    return res.signal ? 128 + (os.constants.signals[res.signal] || 0) : 0;
  } finally {
    doReclaim();
    process.removeListener("exit", doReclaim);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

// Set `process.exitCode` rather than calling `process.exit(code)`: a large
// `--print` blob is written to stdout asynchronously, and `process.exit()`
// truncates the undrained pipe buffer (a silent-truncation bug the user-flow
// walk caught — file redirects + the in-process test harness never hit it,
// only real piping does). `--print` IS the §10.2 byte-parity surface that gets
// piped (`coc-run --print | diff - csq-out`), so the launcher MUST let Node
// flush stdout before exiting. The spawn path uses inherited stdio (no Node
// buffering) and signal handlers still exit promptly.
// EPIPE-tolerant stdout for the CLI entry point: a reader that closes the pipe
// early (`coc-run --print | head`, or the §10.2 byte-parity `--print | diff`,
// which stops at the first divergence) leaves an in-flight write to fail with
// EPIPE. Without a handler Node throws an uncaught 'error' event + stack — a
// crash on the exact byte-parity surface. SIGPIPE semantics: the reader got the
// bytes it wanted, so a clean exit 0 is correct. Registered ONLY at the CLI
// entry (not in run(), which is exported + called in-process — registering
// there would re-introduce the listener-leak class fixed on the spawn path).
function installEpipeGuard() {
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

function main() {
  installEpipeGuard();
  process.exitCode = run(process.argv.slice(2));
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file://${fs.realpathSync(process.argv[1] || "")}`;
if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`coc-run: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  }
}

export {
  resolveSurface,
  parseArtifact,
  scalarField,
  listField,
  splitFlowItems,
  verifyLock,
  loadCocSet,
  filterForSurface,
  translateL1,
  materializeEphemeral,
  reclaim,
  buildSpawn,
  parseArgs,
  sha256Hex,
  SURFACES,
  KINDS,
  UsageError,
  CocError,
};
